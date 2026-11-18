// Preloaded into a server process by tests/sandbox.test.ts. Every way this process could reach the
// network, or hand the job to another process or thread, is refused and written to stderr.
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';

const refuse = (what) => function refused() {
  process.stderr.write(`NETWORK ATTEMPT: ${what}\n`);
  throw new Error('Network use is not allowed in this test');
};
const refuseAll = (target, label, keep = () => false) => {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (name === 'constructor' || keep(name) || typeof target[name] !== 'function') continue;
    target[name] = refuse(`${label}.${name}`);
  }
};
// TCP, TLS, HTTP, HTTP/2, fetch and WebSocket all open their sockets here.
net.Socket.prototype.connect = refuse('socket.connect');
globalThis.fetch = refuse('fetch');
if (globalThis.WebSocket) globalThis.WebSocket = refuse('WebSocket');
// Name resolution: every lookup and resolve function, and the resolver classes behind them.
const resolving = (name) => /^(?:lookup|lookupService|resolve|reverse)/.test(name);
for (const [label, target] of [['dns', dns], ['dns.promises', dns.promises]]) {
  for (const name of Object.keys(target)) if (resolving(name) && typeof target[name] === 'function') target[name] = refuse(`${label}.${name}`);
}
refuseAll(dns.Resolver.prototype, 'dns.Resolver', (name) => !resolving(name));
refuseAll(dns.promises.Resolver.prototype, 'dns.promises.Resolver', (name) => !resolving(name));
// UDP.
for (const name of ['bind', 'connect', 'send']) dgram.Socket.prototype[name] = refuse(`dgram.${name}`);
// Another process or thread would not carry these patches.
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = refuse(`child_process.${name}`);
workerThreads.Worker = refuse('worker_threads.Worker');
syncBuiltinESMExports();
