import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const read = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'));
const [manifest, pkg, schema, account] = await Promise.all(['server.json', 'package.json', 'schemas/server-2025-12-11.json', 'registry/account/server.json'].map(read));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
assert.ok(validate(manifest), JSON.stringify(validate.errors));
assert.equal(manifest.name, pkg.mcpName);
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.packages.length, 1);
assert.equal(manifest.packages[0].identifier, pkg.name);
assert.equal(manifest.packages[0].version, pkg.version);
assert.equal(manifest.packages[0].transport.type, 'stdio');
assert.equal(manifest.remotes[0].url, 'https://mcp.ipvolt.com/mcp');
assert.ok(manifest.description.length <= 100, 'Registry description must be at most100 characters');
// The second Registry entry: the remote account server inside the ipvolt customer app. It names no package, and it is
// not the hosted toolkit. registry/account/check.py fixes the rest of it.
assert.ok(validate(account), JSON.stringify(validate.errors));
assert.equal(account.$schema, manifest.$schema);
assert.notEqual(account.name, manifest.name);
assert.equal(account.packages, undefined);
assert.deepEqual(account.remotes.map(remote => remote.url), ['https://ipvolt.com/beta/mcp']);
assert.ok(account.description.length <= 100, 'Registry description must be at most 100 characters');
console.log(JSON.stringify({ ok: true, name: manifest.name, version: manifest.version, schema: manifest.$schema, account: { name: account.name, version: account.version } }));
