import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Maintainer-only build tool. This script is excluded from the npm artifact.
const [sourceArg, release, scope, ...extra] = process.argv.slice(2);
if (!sourceArg || !release || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(release) || (scope !== undefined && scope !== '--bundled-only') || extra.length) {
  throw new Error('Usage: tsx scripts/export-content.ts VERIFIED_WEBSITE_SOURCE REVIEWED_RELEASE [--bundled-only]');
}
const source = resolve(sourceArg);
const output = new URL('../content/catalog.json', import.meta.url);
process.chdir(source);
const { getPublishedGuides } = await import(pathToFileURL(resolve(source, 'src/lib/seo.ts')).href);
const { getPublishedPosts } = await import(pathToFileURL(resolve(source, 'src/lib/blog.ts')).href);
const { renderPageMarkdown } = await import(pathToFileURL(resolve(source, 'src/lib/markdown.ts')).href);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
// --bundled-only refreshes the documents already in the bundle that are still published, and adds none.
const bundled = scope ? new Set((JSON.parse(await readFile(output, 'utf8')).documents as {id: string}[]).map(d => d.id)) : null;
const entries = [
  ...getPublishedGuides().map((g: {slug: string;title: string;description: string;updatedAt: string;category: string}) => ({
    id: `/guides/${g.slug}`, title: g.title, description: g.description, reviewedAt: g.updatedAt,
    topic: ({ Integration: 'setup', Setup: 'setup', Troubleshooting: 'troubleshooting', Country: 'countries' } as Record<string,string>)[g.category] ?? 'concepts',
  })),
  ...getPublishedPosts().map((p: {slug: string;title: string;description: string;updatedAt: string;draft: boolean}) => {
    if (p.draft) throw new Error('Published loader returned a draft');
    return {id: `/blog/${p.slug}`, title: p.title, description: p.description, reviewedAt: p.updatedAt, topic: 'analysis'};
  }),
].filter(entry => !bundled || bundled.has(entry.id)).sort((a,b) => a.id.localeCompare(b.id));
const documents = entries.map(entry => {
  if (!/^\/(guides|blog)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)) throw new Error('Unexpected public document ID');
  const markdown = renderPageMarkdown(entry.id);
  if (typeof markdown !== 'string' || !markdown.startsWith('# ')) throw new Error('Missing public renderer');
  return {...entry, url: `https://ipvolt.com${entry.id}`, markdown, sha256: hash(markdown)};
});
if (new Set(documents.map(d => d.id)).size !== documents.length) throw new Error('Duplicate document');
const dropped = bundled ? [...bundled].filter(id => !documents.some(d => d.id === id)).sort() : [];
if (dropped.length) process.stderr.write(`No longer published, left out: ${dropped.join(', ')}\n`);
if (!documents.length) throw new Error('No document left to export');
const bundleSha256 = hash(JSON.stringify(documents));
let generatedAt = new Date().toISOString();
try {
  const old = JSON.parse(await readFile(output, 'utf8'));
  if (old.bundleSha256 === bundleSha256 && old.sourceRelease === release) generatedAt = old.generatedAt;
} catch { /* The first export has no previous bundle. */ }
await mkdir(new URL('../content/', import.meta.url), {recursive:true});
await writeFile(output, JSON.stringify({schemaVersion:1, sourceRelease:release, generatedAt, bundleSha256, documents}, null, 2) + '\n');
process.stdout.write(JSON.stringify({documents:documents.length,bundleSha256,sourceRelease:release}) + '\n');
