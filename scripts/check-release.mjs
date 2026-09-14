import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(process.env.GITHUB_REPOSITORY, 'ipvolt/proxy-toolkit-mcp');
assert.equal(process.env.GITHUB_REF_TYPE, 'tag', 'Select the reviewed version tag when dispatching publication');
assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`);
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
console.log(JSON.stringify({ ok: true, version: pkg.version, revision: process.env.GITHUB_SHA }));
