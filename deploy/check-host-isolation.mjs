// Runs in the candidate/live systemd unit before the HTTP listener starts.
// No external destination, DNS query, credentials or request body is involved.
import { connect } from 'node:net';

let finished = false;
const socket = connect({ host: '127.0.0.1', port: 9 });
const timer = setTimeout(() => finish(false), 1000);
function finish(denied) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  socket.destroy();
  if (!denied) {
    process.stderr.write('MCP outbound connection restriction was not enforced.\n');
    process.exitCode = 1;
  }
}
socket.once('error', (error) => finish(error.code === 'EPERM'));
socket.once('connect', () => finish(false));
