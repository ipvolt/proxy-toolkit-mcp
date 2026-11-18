// Preloaded into a server process by tests/sandbox.test.ts: any attempt to open a
// socket, resolve a name or fetch is written to stderr and refused.
import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const refuse = (what) => function refused() {
  process.stderr.write(`NETWORK ATTEMPT: ${what}\n`);
  throw new Error('Network use is not allowed in this test');
};
net.Socket.prototype.connect = refuse('socket.connect');
dns.lookup = refuse('dns.lookup');
dns.promises.lookup = refuse('dns.promises.lookup');
dns.resolve = refuse('dns.resolve');
globalThis.fetch = refuse('fetch');
syncBuiltinESMExports();
