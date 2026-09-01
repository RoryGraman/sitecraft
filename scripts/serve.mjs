#!/usr/bin/env node
// Zero-dependency static file server.
// Usage:
//   node scripts/serve.mjs                       serves extension/dist on :4173 and fixtures on :4174
//   node scripts/serve.mjs --root <dir> --port <n>   serves one directory
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
  }
  return out;
}

export function serveDir(root, port, label) {
  const absRoot = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(absRoot, '.' + rel);
      if (!file.startsWith(absRoot)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      let stat = await fs.stat(file).catch(() => null);
      let target = file;
      if (stat?.isDirectory()) {
        target = path.join(file, 'index.html');
        stat = await fs.stat(target).catch(() => null);
      }
      if (!stat) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found: ' + rel);
        return;
      }
      const data = await fs.readFile(target);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Length': data.length,
      });
      res.end(data);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[serve] ${label ?? root} -> http://localhost:${port}/`);
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.root) {
    serveDir(args.root, args.port ?? 4173);
  } else {
    serveDir(path.join(repoRoot, 'extension', 'dist'), 4173, 'extension/dist (harness)');
    serveDir(path.join(repoRoot, 'fixtures'), 4174, 'fixtures');
  }
}
