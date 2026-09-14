import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { VERSION } from '../src/meta.js';

const run = promisify(execFile);

async function unusedPort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()));
  return address.port;
}

test('compiled HTTP starts through the current symlink, discovers tools and shuts down', { timeout: 15_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ipvolt-http-entry-'));
  const current = join(temporary, 'current');
  await symlink(resolve('.'), current, 'dir');
  const port = await unusedPort();
  const child = spawn(process.execPath, [join(current, 'dist/transports/http.js')], {
    cwd: current,
    env: {
      NODE_ENV: 'production',
      IPVOLT_MCP_PORT: String(port),
      IPVOLT_MCP_TRUST_PROXY: '1',
      IPVOLT_MCP_PUBLIC_URL: 'https://mcp.ipvolt.com/mcp',
      IPVOLT_MCP_ALLOWED_ORIGINS: 'https://mcp.ipvolt.com,https://ipvolt.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    while (!stdout.includes('\n') && child.exitCode === null && child.signalCode === null) await pause(10);
    assert.ok(stdout.includes('\n'), 'The symlink entrypoint exited without emitting readiness');
    assert.deepEqual(JSON.parse(stdout.split('\n')[0]!), { event: 'ready', version: VERSION });
    const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).version, VERSION);
    for (const version of ['2025-11-25', '2026-07-28'] as const) {
      const client = new Client({ name: 'symlink-entry-fixture', version: '1.0.0' }, {
        supportedProtocolVersions: [version],
        versionNegotiation: { mode: version === '2026-07-28' ? { pin: version } : 'legacy' },
      });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { 'X-IPVolt-Peer': '127.0.0.1' } },
        }));
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [
          'diagnose_proxy_error', 'generate_proxy_config', 'get_proxy_doc', 'search_proxy_docs',
        ]);
      } finally { await client.close(); }
    }
    child.kill('SIGTERM');
    assert.deepEqual(await closed, [0, null]);
    assert.equal(stderr, '');
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('importing the compiled HTTP factory through a symlink does not start a listener', { timeout: 10_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'ipvolt-http-import-'));
  try {
    const current = join(temporary, 'current');
    await symlink(resolve('.'), current, 'dir');
    const moduleUrl = pathToFileURL(join(current, 'dist/transports/http.js')).href;
    const source = `import { createHttpService } from ${JSON.stringify(moduleUrl)};\nif (typeof createHttpService !== 'function') throw new Error('Missing factory');\nprocess.stdout.write('imported\\n');\n`;
    const importer = join(temporary, 'importer.mjs');
    await writeFile(importer, source);
    for (const args of [[importer], ['--input-type=module', '--eval', source]]) {
      const result = await run(process.execPath, args, { cwd: temporary, env: { NODE_ENV: 'production' }, timeout: 3000 });
      assert.equal(result.stdout, 'imported\n');
      assert.equal(result.stderr, '');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
