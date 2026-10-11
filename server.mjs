// Zero-dependency static server.
//   http://localhost:8080   – for this computer (camera works on localhost)
//   https://<lan-ip>:8443   – for a phone/tablet on the same Wi-Fi (self-signed certificate;
//                             accept the browser warning once). Browsers only allow the camera
//                             on https or localhost.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { existsSync, mkdirSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = +(process.env.PORT || 8080);
const HTTPS_PORT = +(process.env.HTTPS_PORT || 8443);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file) || /[/\\]\.(git|cert)/.test(file)) return res.writeHead(404).end('Not found');
  const size = statSync(file).size;
  const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? +range[1] : 0;
    const end = range[2] ? +range[2] : size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  createReadStream(file).pipe(res);
}

if (!existsSync(join(root, 'vendor/mediapipe/vision_bundle.mjs'))) {
  console.error('vendor/ is missing – run `npm install` first.');
  process.exit(1);
}

createHttp(handler).listen(HTTP_PORT, () => console.log(`\n  This computer:   http://localhost:${HTTP_PORT}`));

const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
const certDir = join(root, '.cert');
const key = join(certDir, 'key.pem'), cert = join(certDir, 'cert.pem');
try {
  if (!existsSync(cert)) {
    mkdirSync(certDir, { recursive: true });
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '825',
      '-subj', '/CN=kizomba-coach.local', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
  }
  createHttps({ key: readFileSync(key), cert: readFileSync(cert) }, handler).listen(HTTPS_PORT, () => {
    for (const ip of ips) console.log(`  Phone / tablet:  https://${ip}:${HTTPS_PORT}   (accept the certificate warning)`);
    console.log('');
  });
} catch (e) {
  console.warn('  (HTTPS disabled – could not create a certificate with openssl:', e.message, ')');
}
