#!/usr/bin/env node
/**
 * pi-history-reviewer — 本地 Web 版 pi 对话历史审查器
 *
 * 用法:
 *   node server.js                     # 默认端口 4000
 *   node server.js --port=8080         # 自定义端口
 *   node server.js --session-dir=X     # 自定义会话目录
 *   node server.js --host=0.0.0.0      # 允许局域网访问
 *
 * 环境变量: PORT / HOST / PI_SESSION_DIR
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { execFileSync } = require('child_process');

// ---------- 配置 ----------
function parseArg(name) {
  const arg = process.argv.find((a) => a.startsWith('--' + name + '='));
  if (arg) return arg.slice(name.length + 3);
  return null;
}

const PORT = parseInt(parseArg('port') || process.env.PORT || '4000', 10);
const HOST = parseArg('host') || process.env.HOST || '127.0.0.1';
const TOKEN = parseArg('token') || process.env.VIZ_TOKEN || ''; // 设置后所有请求需带 ?token=

function getSessionDir() {
  if (parseArg('session-dir')) return path.resolve(parseArg('session-dir'));
  if (process.env.PI_SESSION_DIR) return path.resolve(process.env.PI_SESSION_DIR);
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

const SESSION_DIR = getSessionDir();
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 工具 ----------
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

function readEntries(file) {
  const content = fs.readFileSync(file, 'utf8');
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* 忽略坏行 */
    }
  }
  return entries;
}

function parseSessionMeta(file) {
  const rel = path.relative(SESSION_DIR, file).split(path.sep).join('/');
  let header = null;
  let entryCount = 0;
  const roles = {};
  let totalTokens = 0;
  let totalCost = 0;
  let name = null;
  let firstUser = null;
  let lastModel = null;
  let leafId = null;

  const entries = readEntries(file);
  for (const e of entries) {
    entryCount++;
    if (e.type === 'session') {
      header = e;
      continue;
    }
    if (e.id) leafId = e.id;

    if (e.type === 'message' && e.message) {
      const m = e.message;
      roles[m.role] = (roles[m.role] || 0) + 1;
      if (m.role === 'assistant' && m.usage) {
        totalTokens += m.usage.totalTokens || 0;
        totalCost += (m.usage.cost && m.usage.cost.total) || 0;
        if (m.provider && m.model) lastModel = `${m.provider}/${m.model}`;
      }
      if (m.role === 'user' && !firstUser) {
        const t = extractText(m.content).trim();
        if (t) firstUser = t;
      }
    } else if (e.type === 'session_info') {
      if (e.name) name = e.name;
    } else if (e.type === 'model_change') {
      lastModel = `${e.provider}/${e.modelId}`;
    }
  }

  return {
    file: rel,
    id: header ? header.id : null,
    version: header ? header.version : null,
    timestamp: header ? header.timestamp : null,
    cwd: header ? header.cwd : null,
    name,
    firstUser,
    entryCount,
    roles,
    totalTokens,
    totalCost,
    lastModel,
    leafId,
  };
}

function listSessions() {
  const files = [];
  walk(SESSION_DIR, files);
  return files
    .map(parseSessionMeta)
    .filter(Boolean)
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
}

function getSession(rel) {
  const root = path.resolve(SESSION_DIR);
  const safe = path.resolve(SESSION_DIR, rel);
  if (safe !== root && !safe.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) return null;

  const entries = readEntries(safe);
  const header = entries.find((e) => e.type === 'session') || null;
  const leafId = entries.length ? entries[entries.length - 1].id : null;
  return { file: rel, header, entries, leafId };
}

function deleteSession(rel) {
  const root = path.resolve(SESSION_DIR);
  const safe = path.resolve(SESSION_DIR, rel);
  if (safe !== root && !safe.startsWith(root + path.sep)) {
    return { ok: false, error: 'invalid path' };
  }
  if (!fs.existsSync(safe)) return { ok: false, error: 'not found' };
  try {
    // 优先放入回收站（与 pi 行为一致），失败则直接删除
    execFileSync('trash', [safe], { stdio: 'ignore' });
  } catch (e) {
    try {
      fs.unlinkSync(safe);
    } catch (e2) {
      return { ok: false, error: String((e2 && e2.message) || e2) };
    }
  }
  return { ok: true };
}

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- 服务器 ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // token 认证：只保护 /api/ 数据接口（静态资源不需 token，否则 <script>/<link> 会 401）
  if (TOKEN && p.startsWith('/api/') && url.searchParams.get('token') !== TOKEN) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Unauthorized');
  }

  if (p === '/api/sessions') {
    return json(res, 200, { sessionsDir: SESSION_DIR, sessions: listSessions() });
  }

  if (p === '/api/session') {
    const rel = url.searchParams.get('file');
    if (!rel) return json(res, 400, { error: 'missing file param' });
    if (req.method === 'DELETE') {
      const r = deleteSession(rel);
      const status = r.ok ? 200 : (r.error === 'not found' ? 404 : 400);
      return json(res, status, r);
    }
    const session = getSession(rel);
    if (!session) return json(res, 404, { error: 'session not found' });
    return json(res, 200, session);
  }

  return serveStatic(res, p);
});

server.listen(PORT, HOST, () => {
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  π Pi History Reviewer                      │');
  console.log('└─────────────────────────────────────────────┘');
  console.log(`  会话目录: ${SESSION_DIR}`);
  console.log(`  打开:     http://${HOST}:${PORT}${TOKEN ? '/?token=' + TOKEN : ''}`);
  console.log('  Ctrl+C 退出');
});
