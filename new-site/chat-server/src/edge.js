// The public side: TLS ends here, on this server, not on the mirrors.
//
// A mirror forwards raw TCP (nginx stream, optionally with a PROXY protocol header) from its
// port 8443 to LISTEN_TLS here, so it only ever sees encrypted bytes and cannot change the page
// or its scripts. Browsers open https://<mirror IP>:8443/ and send no SNI for an IP address, so
// the certificate is picked by address: the PROXY header's destination when it is a public IP,
// else the mirror's own address as seen here (on NAT clouds such as AWS the mirror's outbound
// address is its public IP, while the PROXY destination is its private one).
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';

const V2_SIG = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);

export const plainIp = (a) => String(a || '').replace(/^::ffff:/, '');

export function isPublicIPv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

// Parses a PROXY protocol v1 or v2 header at the start of `buf`.
// -> { done: false } (need more bytes) | { done: true, dst, rest } ; dst is null without a header
export function parseProxyHeader(buf) {
  if (buf.length && buf[0] === 0x16) return { done: true, dst: null, rest: buf }; // TLS, no header
  if (buf.length < 16) {
    const want = buf[0] === 0x0d ? V2_SIG : Buffer.from('PROXY ');
    if (!want.subarray(0, Math.min(buf.length, want.length)).equals(buf.subarray(0, Math.min(buf.length, want.length)))) throw new Error('not a PROXY header');
    return { done: false };
  }
  if (buf.subarray(0, 12).equals(V2_SIG)) {
    const len = buf.readUInt16BE(14);
    if (buf.length < 16 + len) return { done: false };
    const fam = buf[13];
    const dst = fam === 0x11 && len >= 12 ? [...buf.subarray(20, 24)].join('.') : null; // TCP over IPv4
    return { done: true, dst, rest: buf.subarray(16 + len) };
  }
  if (buf.subarray(0, 6).toString('latin1') === 'PROXY ') {
    const end = buf.indexOf('\r\n');
    if (end < 0) {
      if (buf.length > 107) throw new Error('PROXY v1 header too long');
      return { done: false };
    }
    const parts = buf.subarray(0, end).toString('latin1').split(' ');
    const dst = parts[1] === 'TCP4' && net.isIPv4(parts[3] || '') ? parts[3] : null;
    return { done: true, dst, rest: buf.subarray(end + 2) };
  }
  throw new Error('not a PROXY header');
}

// Reads the optional PROXY header, then hands back a stream of what follows it
function readHeader(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('timeout')), timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const r = parseProxyHeader(buf);
        if (r.done) done(null, r);
      } catch (err) {
        done(err);
      }
    };
    const onEnd = () => done(new Error('closed'));
    function done(err, r) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
      socket.pause();
      if (err) reject(err);
      else resolve(r);
    }
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onEnd);
  });
}

// A duplex over `socket` that first yields `head` (bytes already read past the PROXY header)
function withHead(socket, head) {
  const d = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, enc, cb) {
      socket.write(chunk, cb);
    },
    final(cb) {
      socket.end();
      cb();
    },
    destroy(err, cb) {
      socket.destroy();
      cb(err);
    },
  });
  if (head.length) d.push(head);
  socket.on('data', (chunk) => d.push(chunk) || socket.pause());
  socket.on('end', () => d.push(null));
  socket.on('close', () => d.destroy());
  socket.on('error', () => d.destroy());
  return d;
}

// -> net.Server that terminates TLS and passes the decrypted connection to `httpServer`
export function createEdge({ httpServer, certs, config }) {
  return net.createServer({ pauseOnConnect: true }, async (socket) => {
    socket.on('error', () => {});
    const peer = plainIp(socket.remoteAddress);
    if (config.allowFrom.size && !config.allowFrom.has(peer)) return socket.destroy();
    let r;
    try {
      socket.resume();
      r = await readHeader(socket, 5000);
    } catch {
      return socket.destroy();
    }
    const addr = r.dst && isPublicIPv4(r.dst) && certs.has(r.dst) ? r.dst : peer;
    const secureContext = certs.context(addr);
    // No certificate: not a mirror, or one whose certificate is still being issued (issuance
    // starts only from a check-in, so scanners hitting this port cannot use up the budget)
    if (!secureContext) return socket.destroy();
    certs.touch(addr);
    const tlsSocket = new tls.TLSSocket(withHead(socket, r.rest), { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
    tlsSocket.on('error', () => tlsSocket.destroy());
    httpServer.emit('connection', tlsSocket);
  });
}
