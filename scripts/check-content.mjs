import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadPublicCatalog } from '../dist/core/catalog.js';

const bundle = JSON.parse(await readFile(new URL('../content/catalog.json', import.meta.url), 'utf8'));
const catalog = loadPublicCatalog(); // Validates schema, canonical IDs and every hash.
const live = process.argv.includes('--live');
for (const document of bundle.documents) {
  assert.match(document.markdown, /^# /);
  assert.ok(document.markdown.includes(`Source: ${document.url}\n`));
  if (live) {
    const response = await fetch(`${document.url}.md`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, document.id);
    assert.match(response.headers.get('content-type') ?? '', /text\/markdown/);
    const hash = createHash('sha256').update(await response.text()).digest('hex');
    assert.equal(hash, document.sha256, `Live reviewed document changed: ${document.id}`);
  }
}
console.log(JSON.stringify({ ok: true, documents: bundle.documents.length, liveParity: live, ...catalog.provenance }));
