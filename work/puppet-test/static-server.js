// static-server.js - Minimal static file server (zero deps, Node built-ins only)
// Usage: node static-server.js <ROOT_DIR> <PORT>
//        env WEB_ROOT / PORT 也可
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || process.env.WEB_ROOT || '.');
const PORT = parseInt(process.argv[3] || process.env.PORT || '8090', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (e) { res.writeHead(400); return res.end('Bad URL'); }
  if (p === '/' || p === '') p = '/dashboard.html';
  let fp = path.join(ROOT, p);
  // 安全:禁止越界
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      // 也尝试 .html 后缀
      if (!fp.endsWith('.html') && !fp.endsWith('.js')) {
        const alt = fp + '.html';
        if (fs.existsSync(alt)) fp = alt; else { res.writeHead(404); return res.end('Not Found: ' + p); }
      } else { res.writeHead(404); return res.end('Not Found: ' + p); }
    }
    fs.readFile(fp, (err2, data) => {
      if (err2) { res.writeHead(500); return res.end('Read error'); }
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[static-server] http://127.0.0.1:' + PORT + '  root=' + ROOT);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
