// One-request-per-connection JSON protocol over the session's unix socket.
//
// Request:  {"op":"claim","boundary":"before-tool"|"after-tool","agent":..,
//            "event":..,"doing":..,"projectDir":..,"sessionId":..}
// Response: {"messages":[{id,text,urgency,queuedAt}, ...]}

import net from 'node:net';

const MAX_REQUEST_BYTES = 1 << 20;

/** @param {(req:object)=>object} handle */
export function listen(sockPath, handle) {
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) return conn.destroy();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      let reply;
      try {
        reply = handle(JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        reply = { error: String(err && err.message ? err.message : err) };
      }
      conn.end(JSON.stringify(reply) + '\n');
    });
    conn.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => resolve(server));
  });
}

export function request(sockPath, req, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath);
    let buf = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('timed out waiting for the inject wrapper'));
    }, timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(JSON.stringify(req) + '\n'));
    conn.on('data', (chunk) => (buf += chunk));
    conn.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
