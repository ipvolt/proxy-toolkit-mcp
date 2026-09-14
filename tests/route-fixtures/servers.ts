import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
interface TestCertificate { key: Buffer; cert: Buffer; cleanup: () => Promise<void> }

/** Ephemeral fixture material: no private keys are stored in the repository. */
export async function createCertificate(): Promise<TestCertificate> {
  const directory = await mkdtemp(join(tmpdir(), 'ipvolt-route-fixture-'));
  try {
    await runFile('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
      '-subj', '/CN=route.test', '-addext', 'subjectAltName=DNS:route.test',
    ], { timeout: 10_000 });
    return {
      key: await readFile(join(directory, 'key.pem')),
      cert: await readFile(join(directory, 'cert.pem')),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error('Could not generate the ephemeral route test certificate.');
  }
}

export interface FixtureOptions {
  proxyStatus?: number;
  stallConnect?: boolean;
  stallTls?: boolean;
  oversizedConnectHeaders?: boolean;
  onEcho?: (request: http.IncomingMessage, response: http.ServerResponse) => void;
}

export async function createRouteFixture(certificate: TestCertificate, options: FixtureOptions = {}) {
  const sockets = new Set<Socket>();
  const connectAuthorities: string[] = [];
  const proxyAuthorizations: (string | undefined)[] = [];
  const echoRequests: { method: string | undefined; path: string | undefined; proxyAuthorization: string | undefined }[] = [];
  function track(socket: Socket): void {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  }
  const origin = https.createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => {
    echoRequests.push({ method: request.method, path: request.url, proxyAuthorization: request.headers['proxy-authorization'] });
    if (options.onEcho) { options.onEcho(request, response); return; }
    const nonce = new URL(request.url ?? '/', 'https://route.test').searchParams.get('nonce');
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ip: '198.51.100.42', nonce }));
  });
  origin.on('connection', track);
  origin.on('tlsClientError', () => {});
  const originPort = await listen(origin);
  const proxy = http.createServer((_request, response) => {
    response.writeHead(405); response.end();
  });
  proxy.on('connection', track);
  proxy.on('connect', (request, client, head) => {
    // CONNECT transfers stream ownership out of the HTTP parser. Drain stalled
    // fixtures too so they observe peer FIN and do not manufacture socket leaks.
    client.on('end', () => client.destroy());
    connectAuthorities.push(request.url ?? '');
    proxyAuthorizations.push(request.headers['proxy-authorization']);
    if (options.stallConnect) { client.resume(); return; }
    if (options.oversizedConnectHeaders) {
      client.end(`HTTP/1.1 200 OK\r\nX-Large: ${'a'.repeat(10_000)}\r\n\r\n`);
      return;
    }
    if (options.proxyStatus && (options.proxyStatus < 200 || options.proxyStatus >= 300)) {
      client.end(`HTTP/1.1 ${options.proxyStatus} Test response\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    if (options.stallTls) { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); client.resume(); return; }
    // The test proxy never resolves a requested host or connects off loopback.
    const upstream = connect({ host: '127.0.0.1', port: originPort });
    track(upstream);
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once('error', () => client.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  });
  const proxyPort = await listen(proxy);
  return {
    endpoint: `https://route.test:${originPort}/egress`,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    ca: certificate.cert,
    connectAuthorities,
    proxyAuthorizations,
    echoRequests,
    socketCount: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all([closeServer(proxy), closeServer(origin)]);
    },
  };
}

async function listen(server: http.Server | https.Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Fixture has no TCP address.')); return; }
      resolve(address.port);
    });
  });
}

async function closeServer(server: http.Server | https.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('Fixture condition was not reached before its deadline.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
