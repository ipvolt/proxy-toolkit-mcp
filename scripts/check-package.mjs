import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'ipvolt-mcp-pack-'));
const outputFlag = process.argv.indexOf('--output-dir');
if (outputFlag !== -1) assert.ok(process.argv[outputFlag + 1], '--output-dir requires a directory');
const output = outputFlag === -1 ? undefined : resolve(process.argv[outputFlag + 1]);
const clean = join(temp, 'consumer');
await mkdir(clean);
const npmrc = join(temp, 'npmrc');
await writeFile(npmrc, 'registry=https://registry.npmjs.org/\n');
const environment = { ...process.env, NPM_CONFIG_USERCONFIG: npmrc };
environment.PATH = dirname(process.execPath) + delimiter + (process.env.PATH ?? '');
delete environment.NODE_AUTH_TOKEN;
delete environment.NPM_TOKEN;
const expected = ['diagnose_proxy_error', 'generate_proxy_config', 'get_proxy_doc', 'search_proxy_docs'];
try {
  const { stdout } = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: root, env: environment });
  const [packed] = JSON.parse(stdout);
  assert.equal(packed.name, pkg.name);
  assert.equal(packed.version, pkg.version);
  assert.ok(packed.unpackedSize < 1_000_000);
  for (const file of packed.files) {
    assert.ok(/^(?:dist\/.+\.(?:js|d\.ts)|content\/catalog\.json|package\.json|server\.json|README\.md|LICENSE|CONTENT-LICENSE\.md)$/.test(file.path), `Unexpected artifact file: ${file.path}`);
    assert.ok(!file.path.split('/').includes('..'));
  }
  for (const required of ['dist/transports/stdio.js', 'dist/transports/http.js', 'content/catalog.json', 'server.json', 'README.md']) {
    assert.ok(packed.files.some((file) => file.path === required), `Missing artifact file: ${required}`);
  }
  const tarball = join(temp, packed.filename);
  await writeFile(join(clean, 'package.json'), '{"name":"isolated-mcp-consumer","private":true}\n');
  await run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball], { cwd: clean, env: environment });
  const binary = join(clean, 'node_modules/.bin/ipvolt-proxy-toolkit');
  const version = await run(binary, ['--version'], { cwd: clean, env: environment });
  assert.equal(version.stdout.trim(), pkg.version);
  for (const protocol of ['2025-11-25', '2026-07-28']) {
    const client = new Client({ name: 'isolated-package-check', version: '1.0.0' }, {
      supportedProtocolVersions: [protocol], versionNegotiation: { mode: protocol === '2026-07-28' ? { pin: protocol } : 'legacy' },
    });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(clean, 'node_modules', pkg.name, pkg.bin['ipvolt-proxy-toolkit'])], cwd: clean, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (data) => { stderr += data.toString(); });
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), expected);
      for (const [name, args] of [
        ['search_proxy_docs', { query: 'curl proxy', topic: 'setup' }],
        ['get_proxy_doc', { documentId: '/guides/curl-proxy-setup' }],
        ['generate_proxy_config', { client: 'httpx', version: '0.28.1' }],
        ['diagnose_proxy_error', { client: 'httpx', version: '0.28.1', phase: 'proxy_connect', status: 407 }],
      ]) {
        const result = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, name);
        assert.ok(result.structuredContent, name);
      }
      assert.equal(stderr, '');
    } finally { await client.close(); }
  }
  const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
  const report = { ok: true, name: pkg.name, version: pkg.version, filename: packed.filename, sha256, integrity: packed.integrity, files: packed.files.length, unpackedBytes: packed.unpackedSize, node: process.version, protocols: ['2025-11-25', '2026-07-28'], toolCalls: 8 };
  if (output) {
    await mkdir(output, { recursive: true });
    await copyFile(tarball, join(output, packed.filename));
    await writeFile(join(output, 'package-check.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report));
} finally { await rm(temp, { recursive: true, force: true }); }
