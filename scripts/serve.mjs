// Minimal static file server shared by preview and render. Serves the project dir,
// and falls back to the skill's own kit/ when the project has no local copy.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.f32': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

export function startServer({ dir, kitFallback = null, port = 0 }) {
  const root = resolve(dir);
  const kitRoot = kitFallback ? resolve(kitFallback) : null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    rel = normalize(rel).replace(/^([.][.][/\\])+/, '');
    let file = join(root, rel);
    const inRoot = file.startsWith(root + sep) || file === root;
    if (!inRoot && kitRoot) {
      file = join(kitRoot, rel.replace(/^[/\\]kit[/\\]/, ''));
    }
    if (!file.startsWith(root + sep) && !(kitRoot && file.startsWith(kitRoot + sep))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`404 ${rel}`);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}/index.html` })));
}
