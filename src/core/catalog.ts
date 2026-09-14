import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const topicSchema = z.enum(['setup', 'troubleshooting', 'concepts', 'countries', 'analysis']);
const idSchema = z.string().max(160).regex(/^\/(guides|blog)\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const documentSchema = z.object({
  id: idSchema, title: z.string().min(1).max(250), description: z.string().max(1000),
  reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), topic: topicSchema,
  url: z.string().url(), markdown: z.string().min(1).max(200_000), sha256: hashSchema,
}).strict();
const catalogSchema = z.object({
  schemaVersion: z.literal(1), sourceRelease: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/),
  generatedAt: z.iso.datetime(), bundleSha256: hashSchema, documents: z.array(documentSchema).min(1).max(100),
}).strict();
type PublicDocument = z.infer<typeof documentSchema>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export const searchInputSchema = z.object({
  query: z.string().trim().min(2).max(200), topic: topicSchema.optional(),
  limit: z.number().int().min(1).max(5).default(5),
}).strict();
export const documentInputSchema = z.object({
  documentId: idSchema, section: z.string().trim().min(1).max(160).optional(),
  cursor: z.string().regex(/^[a-f0-9]{16}:\d{1,5}$/).optional(),
}).strict();
const provenanceSchema = z.object({sourceRelease:z.string(), bundleSha256:hashSchema, generatedAt:z.string()});
const summarySchema = documentSchema.omit({markdown:true}).extend({snippet:z.string(), score:z.number()});
export const searchOutputSchema = z.object({results:z.array(summarySchema), provenance:provenanceSchema});
export const documentOutputSchema = z.object({
  document:documentSchema.omit({markdown:true}), markdown:z.string(),
  sections:z.array(z.string()), chunk:z.number(), totalChunks:z.number(),
  nextCursor:z.union([z.string(),z.null()]), provenance:provenanceSchema,
});

function splitUtf8(text: string, maxBytes = 11_000): string[] {
  const chunks: string[] = [];
  let chunk = ''; let bytes = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character);
    if (bytes + length > maxBytes) {chunks.push(chunk);chunk = '';bytes = 0;}
    chunk += character; bytes += length;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
function sectionsOf(markdown: string): {title:string; start:number; end:number}[] {
  const sections: {title:string; start:number; end:number; depth:number}[] = [];
  let offset = 0; let fence: string | undefined;
  for (const line of markdown.split(/(?<=\n)/)) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark[0]; else if (fence === mark[0]) fence = undefined;
    } else if (!fence) {
      const match = /^(#{2,6})\s+(.+?)\s*\n?$/.exec(line);
      if (match?.[1] && match[2]) sections.push({title:match[2],start:offset,end:markdown.length,depth:match[1].length});
    }
    offset += line.length;
  }
  return sections.map((section,i) => ({...section,end:sections.slice(i+1).find(next=>next.depth<=section.depth)?.start??markdown.length}));
}
function words(text: string): string[] {
  return [...new Set(text.normalize('NFKD').toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].slice(0,20);
}
function summary(doc: PublicDocument) {const {markdown:_,...rest}=doc;return rest;}

export class PublicCatalog {
  readonly provenance: z.infer<typeof provenanceSchema>;
  private readonly documents: readonly PublicDocument[];
  constructor(value: unknown) {
    const catalog = catalogSchema.parse(value);
    if (hash(JSON.stringify(catalog.documents)) !== catalog.bundleSha256) throw new Error('Public catalog checksum mismatch');
    const ids = new Set<string>();
    for (const doc of catalog.documents) {
      if (ids.has(doc.id) || doc.url !== `https://ipvolt.com${doc.id}` || hash(doc.markdown) !== doc.sha256) throw new Error('Invalid public catalog provenance');
      ids.add(doc.id);
    }
    this.documents = catalog.documents;
    this.provenance = Object.freeze({sourceRelease:catalog.sourceRelease,bundleSha256:catalog.bundleSha256,generatedAt:catalog.generatedAt});
  }
  search(input: z.input<typeof searchInputSchema>): z.infer<typeof searchOutputSchema> {
    const {query,topic,limit} = searchInputSchema.parse(input);
    const terms = words(query);
    const ranked = this.documents.filter(doc=>!topic||doc.topic===topic).map(doc=>{
      const title=doc.title.toLowerCase(), desc=doc.description.toLowerCase(), body=doc.markdown.toLowerCase();
      const score=terms.reduce((score,term)=>score+(title.includes(term)?8:0)+(desc.includes(term)?4:0)+(body.includes(term)?1:0),0);
      const first=terms.map(term=>body.indexOf(term)).filter(i=>i>=0).sort((a,b)=>a-b)[0]??0;
      return {...summary(doc),score,snippet:doc.markdown.slice(Math.max(0,first-100),first+500)};
    }).filter(doc=>doc.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit);
    return {results:ranked,provenance:this.provenance};
  }
  get(input: z.input<typeof documentInputSchema>): z.infer<typeof documentOutputSchema> {
    const {documentId,section,cursor} = documentInputSchema.parse(input);
    const doc = this.documents.find(doc=>doc.id===documentId);
    if (!doc) throw new Error('Unknown reviewed public document. Use search_proxy_docs to find a document ID.');
    const sections=sectionsOf(doc.markdown);
    const selected=section?sections.find(item=>item.title===section):undefined;
    if (section&&!selected) throw new Error('Unknown document section. Use the section titles returned by get_proxy_doc.');
    const text=selected?doc.markdown.slice(selected.start,selected.end):doc.markdown;
    const revision=hash(text).slice(0,16);
    const chunks=splitUtf8(text);
    const chunk=cursor?Number(cursor.split(':')[1]):0;
    if (cursor&&(cursor.split(':')[0]!==revision||chunk>=chunks.length)) throw new Error('Invalid or stale document cursor. Start again without a cursor.');
    return {
      document:summary(doc),markdown:chunks[chunk]!,sections:sections.map(s=>s.title).slice(0,50),
      chunk,totalChunks:chunks.length,nextCursor:chunk+1<chunks.length?`${revision}:${chunk+1}`:null,provenance:this.provenance,
    };
  }
}

let defaultCatalog: PublicCatalog | undefined;
export function loadPublicCatalog(): PublicCatalog {
  if (!defaultCatalog) {
    const bytes=readFileSync(new URL('../../content/catalog.json',import.meta.url));
    if (bytes.length>5_000_000) throw new Error('Public catalog exceeds its size limit');
    defaultCatalog=new PublicCatalog(JSON.parse(bytes.toString('utf8')));
  }
  return defaultCatalog;
}
