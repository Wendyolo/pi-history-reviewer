'use strict';

// token 认证：从 URL 读取，所有请求自动带上（无 token 时为空，服务端不校验）
const VIZ_TOKEN = new URLSearchParams(location.search).get('token') || '';
function apiUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return path + sep + 'token=' + encodeURIComponent(VIZ_TOKEN);
}

/* ============================================================
 *  Pi History Reviewer — 前端逻辑
 * ============================================================ */

// ---------------- 基础工具 ----------------
function $(sel, root) { return (root || document).querySelector(sel); }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTokens(n) { return Number(n || 0).toLocaleString('en-US'); }

function fmtCost(n) {
  const v = Number(n || 0);
  return '$' + (v < 0.0001 && v !== 0 ? v.toExponential(2) : v.toFixed(4));
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
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

// ---------------- Markdown 渲染（带离线降级） ----------------
function inlineMd(s) {
  s = escapeHtml(s);
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[+i] + '</code>');
  return s;
}

function fallbackMarkdown(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      html += '<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' + escapeHtml(buf.join('\n')) + '</code></pre>\n';
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { html += '<h' + h[1].length + '>' + inlineMd(h[2]) + '</h' + h[1].length + '>\n'; i++; continue; }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line.trim())) { html += '<hr>\n'; i++; continue; }

    if (line.startsWith('> ')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('> ')) { buf.push(lines[i].slice(2)); i++; }
      html += '<blockquote>' + buf.map(inlineMd).join('<br>') + '</blockquote>\n';
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      html += '<ul>' + buf.map((x) => '<li>' + inlineMd(x) + '</li>').join('') + '</ul>\n';
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
      html += '<ol>' + buf.map((x) => '<li>' + inlineMd(x) + '</li>').join('') + '</ol>\n';
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) &&
           !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    html += '<p>' + inlineMd(buf.join('<br>')) + '</p>\n';
  }
  return html;
}

function renderMarkdown(text) {
  if (typeof text !== 'string') return '';
  if (window.marked && typeof window.marked.parse === 'function') {
    try {
      const raw = window.marked.parse(text, { breaks: true, gfm: true });
      return window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
    } catch (e) { /* 降级 */ }
  }
  return fallbackMarkdown(text);
}

function highlightCodeBlocks(container) {
  if (!window.hljs) return;
  container.querySelectorAll('pre code').forEach((el) => {
    try {
      if (!el.dataset.highlighted) { hljs.highlightElement(el); el.dataset.highlighted = '1'; }
    } catch (e) { /* ignore */ }
  });
}

// ---------------- 状态 ----------------
const state = {
  sessions: [],
  session: null,      // /api/session 返回的完整会话
  meta: null,         // 计算出的 tokens/cost/model
  tree: null,         // { byId, children, roots }
  currentLeaf: null,
  treeMode: false,
  findQuery: '',
  autoRefresh: false,
  pendingNew: 0,
  errorsOnly: false,
  roleFilter: '',
  toolFilter: '',
  sortMode: 'time-desc',
  renames: {},
};

// ---------------- 会话列表 ----------------
async function loadSessions() {
  try {
    const res = await fetch(apiUrl('/api/sessions'));
    const data = await res.json();
    state.sessions = data.sessions || [];
    lastListSig = listSignature(state.sessions);
    renderSessionList();
  } catch (e) {
    alert('加载会话失败：' + e.message + '\n请确认 server.js 已启动。');
  }
}

function displayPath(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(' / ') || String(p || '');
}

function lastSeg(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

function renderSessionList() {
  const q = ($('#sessionSearch').value || '').toLowerCase();
  const list = $('#sessionList');

  const items = state.sessions.filter((s) => {
    if (!q) return true;
    const hay = [s.name, s.cwd, s.firstUser, s.file, s.lastModel, s.id]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });

  const mode = state.sortMode;
  items.sort((a, b) => {
    if (mode === 'cost-desc') return (b.totalCost || 0) - (a.totalCost || 0);
    if (mode === 'time-asc') return String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
  });

  $('#sessionCount').textContent = items.length + ' / ' + state.sessions.length + ' 个';

  list.innerHTML = '';
  const groups = new Map();
  for (const s of items) {
    const key = s.cwd || '(未知目录)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const frag = document.createDocumentFragment();
  for (const [cwd, arr] of groups) {
    const gh = document.createElement('div');
    gh.className = 'group-head';
    gh.title = cwd;
    gh.innerHTML = '📁 ' + escapeHtml(displayPath(cwd)) + '<span class="group-count">' + arr.length + '</span>';
    frag.appendChild(gh);
    for (const s of arr) frag.appendChild(renderSessionItem(s));
  }
  list.appendChild(frag);
}

function renderSessionItem(s) {
  const div = document.createElement('div');
  div.className = 'session-item';
  if (state.session && state.session.file === s.file) div.classList.add('active');

  const customName = state.renames[s.file] || '';
  const title = customName || s.name || truncate(s.firstUser || '', 60) || '(未命名会话)';
  const base = customName || s.name;
  const preview = (base && s.firstUser && s.firstUser !== base) ? truncate(s.firstUser, 120) : '';
  const meta = [
    s.entryCount ? s.entryCount + ' 条' : '',
    shortModel(s.lastModel),
    s.timestamp ? fmtTime(s.timestamp) : '',
  ].filter(Boolean).join(' · ');

  div.innerHTML =
    '<div class="t" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div>' +
    '<div class="meta">' + escapeHtml(meta) + (s.totalCost ? ' · <span class="cost">' + fmtCost(s.totalCost) + '</span>' : '') + '</div>' +
    (preview ? '<div class="preview">' + escapeHtml(preview) + '</div>' : '') +
    '<div class="item-actions">' +
      '<button class="ia-btn copy" title="复制 Session ID">📋</button>' +
      '<button class="ia-btn rename" title="重命名">✏️</button>' +
      '<button class="ia-btn delete" title="删除会话">🗑</button>' +
    '</div>';

  div.title = (s.cwd || '') + (s.id ? '\nID: ' + s.id : '');
  div.onclick = () => selectSession(s.file);

  div.querySelector('.copy').onclick = (ev) => {
    ev.stopPropagation();
    handleCopy(div.querySelector('.copy'), s);
  };
  div.querySelector('.rename').onclick = (ev) => {
    ev.stopPropagation();
    startRename(div, s);
  };
  div.querySelector('.delete').onclick = (ev) => {
    ev.stopPropagation();
    deleteSessionFile(s.file);
  };
  div.querySelector('.t').addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
    startRename(div, s);
  });
  return div;
}

// ---------------- 复制 / 重命名 / Toast ----------------
let toastTimer = null;
function showToast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.classList.add('hidden'), 220);
  }, 1500);
}

async function copySessionId(s) {
  const id = s.id || '';
  try {
    await navigator.clipboard.writeText(id);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = id;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (err) {}
    document.body.removeChild(ta);
  }
}

async function handleCopy(btn, s) {
  await copySessionId(s);
  btn.textContent = '✓';
  btn.classList.add('copied');
  showToast('Session ID 已复制');
  setTimeout(() => {
    btn.textContent = '📋';
    btn.classList.remove('copied');
  }, 1500);
}

function startRename(div, s) {
  const tEl = div.querySelector('.t');
  const current = state.renames[s.file] || s.name || truncate(s.firstUser || '', 60) || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = current;
  tEl.innerHTML = '';
  tEl.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (save && val) {
      state.renames[s.file] = val;
      showToast('已重命名');
    } else if (save) {
      delete state.renames[s.file];
      showToast('已恢复默认名称');
    }
    saveRenames();
    renderSessionList();
  };

  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    else if (ev.key === 'Escape') { commit(false); }
  });
  input.addEventListener('click', (ev) => ev.stopPropagation());
  input.addEventListener('blur', () => commit(true));
}

function loadRenames() {
  try { state.renames = JSON.parse(localStorage.getItem('pi_reviewer_renames') || '{}') || {}; }
  catch (e) { state.renames = {}; }
}
function saveRenames() {
  try { localStorage.setItem('pi_reviewer_renames', JSON.stringify(state.renames)); }
  catch (e) {}
}

// ---------------- 加载会话 ----------------
async function selectSession(file) {
  try {
    const res = await fetch(apiUrl('/api/session?file=' + encodeURIComponent(file)));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.session = await res.json();
    state.currentLeaf = state.session.leafId;
    state.findQuery = '';
    state.meta = computeMeta(state.session);
    populateToolFilter();

    $('#findInput').value = '';
    $('#findCount').textContent = '';
    $('#updatePill').classList.add('hidden');
    state.pendingNew = 0;
    $('#welcome').classList.add('hidden');
    $('#conversation').classList.remove('hidden');
    $('#treeBtn').classList.remove('hidden');
    $('#exportBtn').classList.remove('hidden');
    $('#exportMdBtn').classList.remove('hidden');
    $('#findInput').classList.remove('hidden');
    $('#viewToolbar').classList.remove('hidden');
    $('#main').scrollTop = 0;

    renderSessionList();
    renderConversation();
    if (state.treeMode) renderTree();
  } catch (e) {
    alert('加载会话失败：' + e.message);
  }
}

function aggregateUsage(entries) {
  const acc = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
    tokens: 0, costTotal: 0,
    costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0,
    toolCalls: 0,
  };
  const add = (u) => {
    if (!u) return;
    acc.input += u.input || 0;
    acc.output += u.output || 0;
    acc.cacheRead += u.cacheRead || 0;
    acc.cacheWrite += u.cacheWrite || 0;
    acc.reasoning += u.reasoning || 0; // reasoning 是 output 的子集，不重复累加
    if (u.cost) {
      acc.costInput += u.cost.input || 0;
      acc.costOutput += u.cost.output || 0;
      acc.costCacheRead += u.cost.cacheRead || 0;
      acc.costCacheWrite += u.cost.cacheWrite || 0;
      acc.costTotal += u.cost.total || 0;
    }
  };
  for (const e of entries) {
    if (e.type === 'message' && e.message) {
      if (e.message.usage) add(e.message.usage);
      if (e.message.role === 'assistant' && Array.isArray(e.message.content)) {
        for (const b of e.message.content) if (b.type === 'toolCall') acc.toolCalls++;
      }
    } else if (e.usage) {
      add(e.usage); // usage / compaction / branch_summary 条目
    }
  }
  // 严格口径：input/output/cacheRead/cacheWrite 互斥，总量为四者之和
  acc.tokens = acc.input + acc.output + acc.cacheRead + acc.cacheWrite;
  return acc;
}

function sessionDuration(entries) {
  let min = null, max = null;
  for (const e of entries) {
    if (!e.timestamp) continue;
    const t = Date.parse(e.timestamp);
    if (isNaN(t)) continue;
    if (min == null || t < min) min = t;
    if (max == null || t > max) max = t;
  }
  if (min == null) return null;
  return (max != null ? max : min) - min;
}

function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '-';
  let s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); s %= 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60); const mm = m % 60;
  return h + 'h ' + mm + 'm';
}

function buildToolStats(entries) {
  const byId = new Map();
  for (const e of entries) if (e.id) byId.set(e.id, e);
  const stats = new Map();
  const ts = (s) => { const t = Date.parse(s); return isNaN(t) ? null : t; };
  for (const e of entries) {
    if (e.type !== 'message' || !e.message || e.message.role !== 'toolResult') continue;
    const m = e.message;
    const name = m.toolName || 'unknown';
    const st = stats.get(name) || { calls: 0, errors: 0, durationMs: 0 };
    st.calls++;
    if (m.isError) st.errors++;
    const tEnd = ts(e.timestamp);
    const parent = byId.get(e.parentId);
    const tStart = parent ? ts(parent.timestamp) : null;
    if (tEnd != null && tStart != null && tEnd >= tStart) st.durationMs += (tEnd - tStart);
    stats.set(name, st);
  }
  return [...stats.entries()].sort((a, b) => b[1].calls - a[1].calls);
}

function populateToolFilter() {
  if (!state.session) return;
  const sel = $('#toolFilter');
  const names = new Set();
  for (const e of state.session.entries) {
    if (e.type !== 'message' || !e.message) continue;
    if (e.message.role === 'toolResult' && e.message.toolName) names.add(e.message.toolName);
    else if (e.message.role === 'assistant' && Array.isArray(e.message.content)) {
      for (const b of e.message.content) if (b.type === 'toolCall' && b.name) names.add(b.name);
    }
  }
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部工具</option>' +
    [...names].sort().map((n) => '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>').join('');
  if (cur && names.has(cur)) sel.value = cur;
  else if (cur) { sel.value = ''; state.toolFilter = ''; }
}

function computeMeta(s) {
  const usage = aggregateUsage(s.entries);
  let model = null;
  for (const e of s.entries) {
    if (e.type === 'message' && e.message && e.message.role === 'assistant' && e.message.provider && e.message.model) {
      model = e.message.provider + '/' + e.message.model;
    }
  }
  return {
    tokens: usage.tokens,
    cost: usage.costTotal,
    model,
    usage,
    durationMs: sessionDuration(s.entries),
    toolCalls: usage.toolCalls,
    toolStats: buildToolStats(s.entries),
  };
}

function getSessionName(s) {
  let name = null;
  for (const e of s.entries) {
    if (e.type === 'session_info' && e.name) name = e.name;
  }
  return name;
}

async function deleteSessionFile(file) {
  if (!confirm('确定删除该会话？\n\n' + file + '\n\n（有 trash 命令时放入回收站，否则直接删除）')) return;
  try {
    const res = await fetch(apiUrl('/api/session?file=' + encodeURIComponent(file)), { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    if (state.session && state.session.file === file) {
      state.session = null;
      state.currentLeaf = null;
      state.tree = null;
      $('#conversation').classList.add('hidden');
      $('#welcome').classList.remove('hidden');
      $('#treeBtn').classList.add('hidden');
      $('#exportBtn').classList.add('hidden');
      $('#exportMdBtn').classList.add('hidden');
      $('#findInput').classList.add('hidden');
      $('#viewToolbar').classList.add('hidden');
      $('#findCount').textContent = '';
    }
    await loadSessions();
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

// ---------------- 树结构 ----------------
function buildTree(entries) {
  const byId = new Map();
  const children = new Map();
  const roots = [];
  for (const e of entries) if (e.id && e.type !== 'session') byId.set(e.id, e);
  for (const e of entries) {
    if (!e.id || e.type === 'session') continue; // 排除 session 头（非对话节点）
    if (e.parentId == null) roots.push(e.id);
    else {
      if (!children.has(e.parentId)) children.set(e.parentId, []);
      children.get(e.parentId).push(e.id);
    }
  }
  return { byId, children, roots };
}

function pathToLeaf(byId, leafId) {
  const path = [];
  let cur = leafId;
  let guard = 0;
  while (cur && byId.has(cur) && guard++ < 100000) {
    path.unshift(byId.get(cur));
    cur = byId.get(cur).parentId;
  }
  return path;
}

function isToolResultEntry(e) {
  return e.type === 'message' && e.message && e.message.role === 'toolResult';
}

// ---------------- 主渲染 ----------------
function renderConversation() {
  const container = $('#conversation');
  container.innerHTML = '';
  const s = state.session;
  if (!s) return;

  state.tree = buildTree(s.entries);
  const { byId } = state.tree;

  container.appendChild(renderSessionBanner(s));

  const leaf = state.currentLeaf || s.leafId;
  const path = pathToLeaf(byId, leaf);

  const errorToolCallIds = new Set();
  const errorAssistantIds = new Set();
  for (const e of path) {
    if (isToolResultEntry(e) && e.message && e.message.isError) {
      errorToolCallIds.add(e.message.toolCallId);
      if (e.parentId) errorAssistantIds.add(e.parentId);
    }
  }

  const timeline = document.createElement('div');
  timeline.className = 'timeline';

  const q = state.findQuery.trim().toLowerCase();
  const rf = state.roleFilter;
  const tf = state.toolFilter;
  let matchCount = 0;
  const ctx = {
    errorsOnly: state.errorsOnly,
    errorToolCallIds,
    errorAssistantIds,
    roleFilter: rf,
    toolFilter: tf,
  };

  for (let i = 0; i < path.length; i++) {
    const e = path[i];
    const isTr = isToolResultEntry(e);
    const isAsst = e.type === 'message' && e.message && e.message.role === 'assistant';
    const isUser = e.type === 'message' && e.message && e.message.role === 'user';

    if (isTr) {
      // 孤立工具结果
      if (rf && rf !== 'tool') continue;
      if (tf && (!e.message || e.message.toolName !== tf)) continue;
      if (state.errorsOnly && !(e.message && e.message.isError)) continue;
      const node = renderToolResultCard(e, s, true);
      if (node) { applyFind(q, node, () => matchCount++); timeline.appendChild(node); }
      continue;
    }

    if (isAsst) {
      if (rf && rf !== 'assistant' && rf !== 'tool') { i = skipChildren(path, i); continue; }
      const results = [];
      let j = i + 1;
      while (j < path.length && isToolResultEntry(path[j]) && path[j].parentId === e.id) j++;
      for (let k = i + 1; k < j; k++) {
        const r = path[k];
        if (state.errorsOnly && !(r.message && r.message.isError)) continue;
        if (tf && (!r.message || r.message.toolName !== tf)) continue;
        results.push(r);
      }
      const node = renderAssistantTimeline(e, e.message, ctx, results);
      if (node) { applyFind(q, node, () => matchCount++); timeline.appendChild(node); }
      if (j > i + 1) i = j - 1;
      continue;
    }

    if (isUser) {
      if (rf && rf !== 'user') continue;
      const node = renderTimelineEntry(e, s, ctx);
      if (node) { applyFind(q, node, () => matchCount++); timeline.appendChild(node); }
      continue;
    }

    // marker 等其它条目：过滤启用时隐藏
    if (rf || tf) continue;
    const node = renderTimelineEntry(e, s, ctx);
    if (node) { applyFind(q, node, () => matchCount++); timeline.appendChild(node); }
  }

  container.appendChild(timeline);
  highlightCodeBlocks(container);
  if (q) highlightMatches(timeline, q);
  $('#findCount').textContent = q ? matchCount + ' 条匹配' : '';
}

function applyFind(q, node, onMatch) {
  if (!q) return;
  if ((node.textContent || '').toLowerCase().includes(q)) onMatch();
  else node.classList.add('find-hidden');
}

function skipChildren(path, i) {
  let j = i + 1;
  while (j < path.length && isToolResultEntry(path[j]) && path[j].parentId === path[i].id) j++;
  return j - 1;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightMatches(container, query) {
  if (!query) return;
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const v = node.nodeValue;
      if (!v || !v.toLowerCase().includes(q)) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE' || p.tagName === 'MARK')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const re = new RegExp(escapeRegExp(query), 'gi');
  for (const node of nodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function renderSessionBanner(s) {
  const h = s.header || {};
  const meta = state.meta || {};
  const u = meta.usage || {};
  const div = document.createElement('div');
  div.className = 'session-banner';
  const name = getSessionName(s) || '(未命名会话)';
  div.innerHTML =
    '<h2>' + escapeHtml(name) + '</h2>' +
    '<div class="line">📁 ' + escapeHtml(h.cwd || '-') + '</div>' +
    '<div class="line">🕐 ' + fmtTime(h.timestamp) + ' · ID: ' + escapeHtml(h.id || '-') + '</div>' +
    '<div class="stats">' +
      '<span class="badge">' + s.entries.length + ' 条记录</span>' +
      (meta.model ? '<span class="badge">' + escapeHtml(meta.model) + '</span>' : '') +
      '<span class="badge">⏱ ' + fmtDuration(meta.durationMs) + '</span>' +
      '<span class="badge">🔧 ' + (meta.toolCalls || 0) + ' 次工具调用</span>' +
    '</div>' +
    '<div class="usage-row">' +
      '<div class="u-item"><div class="u-val">' + fmtTokens(u.input || 0) + '</div><div class="u-label">input</div></div>' +
      '<div class="u-item"><div class="u-val">' + fmtTokens(u.output || 0) + '</div><div class="u-label">output</div></div>' +
      '<div class="u-item"><div class="u-val">' + fmtTokens(u.cacheRead || 0) + '</div><div class="u-label">cacheRead</div></div>' +
      '<div class="u-item"><div class="u-val">' + fmtTokens(u.cacheWrite || 0) + '</div><div class="u-label">cacheWrite</div></div>' +
      '<div class="u-item total"><div class="u-val">' + fmtTokens(u.tokens || 0) + '</div><div class="u-label">总 token</div></div>' +
      '<div class="u-item total cost"><div class="u-val">' + fmtCost(meta.cost || 0) + '</div><div class="u-label">总费用</div></div>' +
    '</div>';
  return div;
}

// ---------------- 时间线条目渲染 ----------------
function renderTimelineEntry(e, s, ctx) {
  switch (e.type) {
    case 'message': return renderTimelineMessage(e, s, ctx);
    case 'compaction': return renderCompaction(e);
    case 'branch_summary': return renderBanner(e, '🌿 分支摘要', e.summary || '', 'branch');
    case 'model_change': return ctx.errorsOnly ? null : renderBanner(e, '🔄 模型切换', (e.provider || '') + ' / ' + (e.modelId || ''), 'model');
    case 'thinking_level_change': return ctx.errorsOnly ? null : renderBanner(e, '🧠 思考等级', e.thinkingLevel || '', 'think');
    case 'usage': {
      if (ctx.errorsOnly) return null;
      const u = e.usage || {};
      return renderBanner(e, '📊 用量', (e.kind || 'usage') + ' · ' + fmtTokens(u.totalTokens) + ' tok' + (u.cost && u.cost.total ? ' · ' + fmtCost(u.cost.total) : ''), '');
    }
    case 'custom': return null;
    case 'custom_message': return ctx.errorsOnly ? null : renderCustomMessage(e, s);
    case 'label': return ctx.errorsOnly ? null : renderBanner(e, '🏷 标签', e.label || '', 'label');
    case 'session_info': return ctx.errorsOnly ? null : renderBanner(e, '📝 会话名称', e.name || '', 'label');
    case 'session': return null;
    default: return ctx.errorsOnly ? null : renderBanner(e, e.type, '', '');
  }
}

function renderTimelineMessage(e, s, ctx) {
  const m = e.message || {};
  switch (m.role) {
    case 'user': return renderUserTimeline(e, m);
    case 'assistant': return renderAssistantTimeline(e, m, ctx, []);
    case 'system': return ctx.errorsOnly ? null : renderSystem(e, m);
    case 'bashExecution': return renderBashTimeline(e, m, ctx);
    case 'custom': return ctx.errorsOnly ? null : renderCustomMessage(e, s, m);
    case 'branchSummary': return renderBanner(e, '🌿 分支摘要', m.summary || '', 'branch');
    case 'compactionSummary': return renderBanner(e, '🗜️ 压缩摘要', m.summary || '', 'branch');
    default: return null;
  }
}

function tlMetaLine(role, sub, right) {
  const d = document.createElement('div');
  d.className = 'tl-meta' + (right ? ' right' : '');
  d.innerHTML = '<span class="tl-role">' + role + '</span>' + (sub ? '<span class="tl-sub">' + sub + '</span>' : '');
  return d;
}

function imageHtml(b) {
  return '<img src="data:' + (b.mimeType || 'image/png') + ';base64,' + (b.data || '') + '" alt="" />';
}

function renderUserTimeline(e, m) {
  const node = document.createElement('div');
  node.className = 'tl-node tl-user';
  node.appendChild(tlMetaLine('👤 用户', fmtTime(e.timestamp)));
  const card = document.createElement('div');
  card.className = 'tl-card user';
  renderContentBlocks(m.content, card);
  node.appendChild(card);
  highlightCodeBlocks(card);
  return node;
}

const AUTO_COLLAPSE_LEN = 3000; // 长回复超过此字符数默认折叠

function shortModel(m) {
  if (!m) return '';
  const seg = String(m).split('/').pop() || m;
  return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderAssistantTimeline(e, m, ctx, results) {
  if (ctx.errorsOnly && !ctx.errorAssistantIds.has(e.id)) return null;

  const roleFilter = ctx.roleFilter;
  const toolFilter = ctx.toolFilter;
  const blocks = m.content || [];

  if (toolFilter && !blocks.some((b) => b.type === 'toolCall' && b.name === toolFilter)) return null;

  const node = document.createElement('div');
  node.className = 'tl-node tl-assistant';
  const u = m.usage || {};
  const modelShort = shortModel([m.provider, m.model].filter(Boolean).join('/'));
  const tokenInfo = (u.input != null || u.output != null)
    ? fmtTokens(u.input || 0) + '→' + fmtTokens(u.output || 0) + ' tok' + (u.cost && u.cost.total ? ' · ' + fmtCost(u.cost.total) : '')
    : '';
  const metaEl = document.createElement('div');
  metaEl.className = 'tl-meta right';
  metaEl.innerHTML =
    '<span class="tl-role">🤖 助手</span>' +
    (modelShort ? '<span class="tl-model">' + escapeHtml(modelShort) + '</span>' : '') +
    (tokenInfo ? '<span class="tl-tokens">' + escapeHtml(tokenInfo) + '</span>' : '');
  node.appendChild(metaEl);

  const plainText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  const showText = roleFilter !== 'tool' && !toolFilter;

  if (showText) {
    for (const b of blocks) {
      if (b.type !== 'thinking') continue;
      if (ctx.errorsOnly) continue;
      node.appendChild(renderThinking(b));
    }
  }

  const textBlocks = blocks.filter((b) => b.type === 'text');
  const imageBlocks = blocks.filter((b) => b.type === 'image');
  if (showText && (textBlocks.length || imageBlocks.length)) {
    const bubble = document.createElement('div');
    bubble.className = 'tl-bubble assistant';
    const long = plainText.length > AUTO_COLLAPSE_LEN;
    if (long) bubble.classList.add('collapsed');

    let full = '';
    for (const b of textBlocks) full += '<div class="md">' + renderMarkdown(b.text || '') + '</div>';
    for (const b of imageBlocks) full += imageHtml(b);

    if (long) {
      bubble.innerHTML =
        '<div class="tl-bubble-preview">' + escapeHtml(truncate(plainText, 200)) + '</div>' +
        '<div class="tl-bubble-full">' + full + '</div>' +
        '<button class="tl-bubble-toggle">展开</button>';
      bubble.querySelector('.tl-bubble-toggle').onclick = () => {
        const c = bubble.classList.toggle('collapsed');
        bubble.querySelector('.tl-bubble-toggle').textContent = c ? '展开' : '收起';
      };
    } else {
      bubble.innerHTML = full;
    }
    node.appendChild(bubble);
    highlightCodeBlocks(bubble);
  }

  // 工具调用：单条左侧竖线贯穿其后所有 toolCall / toolResult
  const toolsWrap = document.createElement('div');
  toolsWrap.className = 'tl-tools';
  const remaining = new Map();
  for (const r of results) remaining.set(r.message.toolCallId, r);

  for (const b of blocks) {
    if (b.type !== 'toolCall') continue;
    if (ctx.errorsOnly && !ctx.errorToolCallIds.has(b.id)) continue;
    if (toolFilter && b.name !== toolFilter) continue;
    const group = document.createElement('div');
    group.className = 'tl-tool-group ' + toolTypeClass(b.name);
    group.appendChild(renderToolCallCard(b));
    const r = remaining.get(b.id);
    if (r) {
      group.classList.add('has-result');
      if (r.message && r.message.isError) group.classList.add('has-error');
      group.appendChild(renderToolResultCard(r));
      remaining.delete(b.id);
    }
    toolsWrap.appendChild(group);
  }

  for (const r of remaining.values()) {
    toolsWrap.appendChild(renderToolResultCard(r));
  }

  if (toolsWrap.childNodes.length) node.appendChild(toolsWrap);

  return node;
}

function renderThinking(b) {
  const d = document.createElement('details');
  d.className = 'collapse thinking-block';
  const text = b.thinking || '';
  const summary = document.createElement('summary');
  summary.innerHTML =
    '💭 <span class="thinking-summary">Thinking</span>' +
    '<span class="thinking-len">' + text.length + ' 字符</span>' +
    (b.redacted ? '<span class="err"> · redacted</span>' : '');
  d.appendChild(summary);
  const wrap = document.createElement('div');
  wrap.className = 'collapse-body';
  const pre = document.createElement('div');
  pre.className = 'plain thinking-body';
  pre.textContent = text || '(空)';
  wrap.appendChild(pre);
  d.appendChild(wrap);
  return d;
}

function toolParamSummary(name, args) {
  const a = args || {};
  if (name === 'bash') return typeof a.command === 'string' ? a.command : '';
  if (name === 'read' || name === 'write' || name === 'edit') {
    return [a.filePath, a.file_path, a.path].find((x) => typeof x === 'string' && x) || '';
  }
  const first = Object.values(a).find((v) => typeof v === 'string' && v);
  return first ? String(first) : '';
}

function toolTypeClass(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'bash') return 'tt-bash';
  if (n === 'read') return 'tt-read';
  if (n === 'write') return 'tt-write';
  if (n === 'edit') return 'tt-edit';
  if (n === 'grep' || n === 'glob' || n === 'find' || n === 'ls') return 'tt-fs';
  return 'tt-default';
}

function renderToolCallCard(b) {
  const card = document.createElement('div');
  card.className = 'tl-tool-call ' + toolTypeClass(b.name);
  card.setAttribute('data-toolcall-id', b.id || '');
  card.title = '点击定位到结果';

  const summary = toolParamSummary(b.name, b.arguments);
  card.innerHTML =
    '<div class="tl-tc-head">' +
      '🔧 <span class="tl-tc-name">' + escapeHtml(b.name || 'tool') + '</span>' +
      (summary ? '<span class="tl-tc-summary">' + escapeHtml(truncate(summary, 90)) + '</span>' : '') +
      '<button class="tl-tc-result-btn" type="button">结果 ↓</button>' +
    '</div>';

  const details = document.createElement('details');
  details.className = 'tl-tc-details';
  const sum = document.createElement('summary');
  sum.textContent = '参数';
  details.appendChild(sum);
  const pre = document.createElement('pre');
  pre.className = 'tool-args json';
  let argsText = '';
  try { argsText = JSON.stringify(b.arguments, null, 2); } catch (err) { argsText = String(b.arguments); }
  pre.textContent = argsText || '(无参数)';
  details.appendChild(pre);
  card.appendChild(details);

  card.addEventListener('click', (ev) => {
    if (ev.target.closest('.tl-tc-details')) return;
    scrollToResult(b.id);
  });
  return card;
}

function scrollToResult(toolCallId) {
  if (!toolCallId) return;
  let target = null;
  document.querySelectorAll('[data-result-for]').forEach((el) => {
    if (!target && el.getAttribute('data-result-for') === toolCallId) target = el;
  });
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1800);
  }
}

function renderToolResultCard(r, s, standalone) {
  const m = r.message || {};
  const text = extractText(m.content);
  const KB = 1024;
  const isLong = text.length > 8 * KB;
  const preview = (text.split('\n').find((l) => l.trim()) || '').trim();

  const node = document.createElement('div');
  node.className = 'tl-node tl-tool-result' + (standalone ? ' standalone' : '');
  if (m.isError) node.classList.add('is-error');
  node.setAttribute('data-result-for', m.toolCallId || '');

  const head = document.createElement('div');
  head.className = 'tr-head';
  head.title = '折叠 / 展开';
  head.innerHTML =
    '<span class="tr-chev">▾</span>' +
    '📄 <span class="name">' + escapeHtml(m.toolName || 'toolResult') + '</span>' +
    (m.isError ? '<span class="err">⚠ 错误</span>' : '<span class="ok">✓</span>') +
    '<span class="tr-meta">' + escapeHtml(truncate(preview, 60)) + (text.length > 60 ? '…' : '') + '</span>';
  node.appendChild(head);

  const chev = head.querySelector('.tr-chev');
  head.style.cursor = 'pointer';
  head.onclick = () => {
    const collapsed = node.classList.toggle('tr-collapsed');
    chev.textContent = collapsed ? '▸' : '▾';
    head.title = collapsed ? '展开' : '折叠';
  };

  const body = document.createElement('div');
  body.className = 'tr-body';

  if (isLong) {
    const truncated = text.slice(0, 2000);
    const pre = document.createElement('div');
    pre.className = 'plain';
    pre.textContent = truncated + '\n…（已截断）';
    body.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'tr-more-btn';
    btn.textContent = '显示完整输出（约 ' + Math.round(text.length / KB) + ' KB）';
    let expanded = false;
    btn.onclick = () => {
      expanded = !expanded;
      pre.textContent = expanded ? text : truncated + '\n…（已截断）';
      btn.textContent = expanded ? '收起' : '显示完整输出（约 ' + Math.round(text.length / KB) + ' KB）';
    };
    body.appendChild(btn);
  } else {
    renderPlainContentBlocks(m.content, body);
  }
  node.appendChild(body);
  return node;
}

function renderSystem(e, m) {
  const node = document.createElement('div');
  node.className = 'tl-node tl-system';
  node.innerHTML = '<div class="tl-meta"><span class="tl-role">⚙️ 系统提示</span><span class="tl-sub">' + fmtTime(e.timestamp) + '</span></div>';
  const list = document.createElement('div');
  list.className = 'system-list';

  const sections = m.sections;
  if (sections && typeof sections === 'object' && Object.keys(sections).length) {
    for (const k of Object.keys(sections)) {
      const content = sections[k] == null ? '' : String(sections[k]);
      const d = document.createElement('details');
      d.className = 'system-prompt-item';
      const summary = document.createElement('summary');
      summary.innerHTML = escapeHtml(k) + '<span class="sys-len">' + content.length + ' 字符</span>';
      d.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'sys-body';
      body.textContent = content;
      d.appendChild(body);
      list.appendChild(d);
    }
  } else if (typeof m.content === 'string' && m.content) {
    const pre = document.createElement('div');
    pre.className = 'plain';
    pre.textContent = m.content;
    list.appendChild(pre);
  }

  const added = m.toolsAdded || [];
  const removed = m.toolsRemoved || [];
  if (added.length || removed.length) {
    const div = document.createElement('div');
    div.className = 'sys-tools';
    div.innerHTML =
      added.map((t) => '<span class="badge">+ ' + escapeHtml(t.name || t) + '</span>').join('') +
      removed.map((t) => '<span class="badge" style="color:var(--red)">− ' + escapeHtml(t.name || t) + '</span>').join('');
    list.appendChild(div);
  }

  node.appendChild(list);
  return node;
}

function renderBashTimeline(e, m, ctx) {
  const isErr = m.cancelled || (m.exitCode != null && m.exitCode !== 0);
  if (ctx.errorsOnly && !isErr) return null;

  const node = document.createElement('div');
  node.className = 'tl-node tl-bash';
  if (isErr) node.classList.add('is-error');
  const status = m.cancelled ? 'cancelled' : (m.exitCode != null ? 'exit ' + m.exitCode : '');
  node.innerHTML =
    '<div class="tl-meta"><span class="tl-role">💻 bash</span><span class="tl-sub">' + escapeHtml(status) + (m.truncated ? ' · truncated' : '') + '</span></div>' +
    '<div class="term-block"></div>';
  const block = node.querySelector('.term-block');

  const cmd = m.command || '';
  const head = document.createElement('div');
  head.className = 'term-head';
  const cmdSpan = document.createElement('span');
  const longCmd = cmd.length > 200;
  cmdSpan.textContent = '$ ' + (longCmd ? cmd.slice(0, 200) + '…' : cmd);
  head.appendChild(cmdSpan);
  if (longCmd) {
    const btn = document.createElement('button');
    btn.className = 'term-expand';
    btn.textContent = '展开';
    let open = false;
    btn.onclick = () => {
      open = !open;
      cmdSpan.textContent = '$ ' + (open ? cmd : cmd.slice(0, 200) + '…');
      btn.textContent = open ? '收起' : '展开';
    };
    head.appendChild(btn);
  }
  block.appendChild(head);

  const body = document.createElement('div');
  body.className = 'term-body';
  body.textContent = m.output || '(无输出)';
  block.appendChild(body);
  return node;
}

function renderCustomMessage(e, s, m) {
  const customType = m ? m.customType : e.customType;
  const content = m ? m.content : e.content;
  const div = document.createElement('div');
  div.className = 'entry';
  div.innerHTML =
    '<div class="msg custom">' +
      '<div class="msg-head"><span class="role">🔌 custom · ' + escapeHtml(customType || '') + '</span></div>' +
      '<div class="msg-body"></div>' +
    '</div>';
  const body = div.querySelector('.msg-body');
  renderContentBlocks(content, body);
  highlightCodeBlocks(body);
  return div;
}

function renderBanner(e, icon, text, cls) {
  const div = document.createElement('div');
  div.className = 'banner ' + (cls || '');
  div.innerHTML =
    '<span class="ico">' + icon + '</span>' +
    '<span>' + escapeHtml(text || '') + '</span>' +
    '<span style="color:var(--muted)">' + fmtTime(e.timestamp) + '</span>';
  return div;
}

function renderCompaction(e) {
  const div = document.createElement('div');
  div.className = 'banner branch';
  div.innerHTML =
    '<span class="ico">🗜️ 上下文压缩</span>' +
    '<span>' + (e.tokensBefore != null ? fmtTokens(e.tokensBefore) + ' tokens → ' : '') + escapeHtml(e.summary || '') + '</span>' +
    '<span style="color:var(--muted)">' + fmtTime(e.timestamp) + '</span>';
  return div;
}

// ---------------- 内容块 ----------------
function renderContentBlocks(content, container) {
  if (typeof content === 'string') {
    const p = document.createElement('div');
    p.className = 'md';
    p.innerHTML = renderMarkdown(content);
    container.appendChild(p);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text') {
      const p = document.createElement('div');
      p.className = 'md';
      p.innerHTML = renderMarkdown(b.text || '');
      container.appendChild(p);
    } else if (b.type === 'image') {
      container.appendChild(renderImage(b));
    }
  }
}

function renderPlainContentBlocks(content, container) {
  if (typeof content === 'string') {
    const pre = document.createElement('div');
    pre.className = 'plain';
    pre.textContent = content;
    container.appendChild(pre);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text') {
      const pre = document.createElement('div');
      pre.className = 'plain';
      pre.textContent = b.text || '';
      container.appendChild(pre);
    } else if (b.type === 'image') {
      container.appendChild(renderImage(b));
    }
  }
}

function renderImage(b) {
  const img = document.createElement('img');
  img.src = 'data:' + (b.mimeType || 'image/png') + ';base64,' + (b.data || '');
  img.style.maxWidth = '100%';
  img.style.borderRadius = '6px';
  img.style.margin = '6px 0';
  return img;
}

// ---------------- 树视图 ----------------
function renderTree() {
  const body = $('#treeBody');
  body.innerHTML = '';
  if (!state.session || !state.tree) return;
  const { byId, children, roots } = state.tree;
  const leaf = state.currentLeaf || state.session.leafId;
  const pathIds = new Set(pathToLeaf(byId, leaf).map((e) => e.id));

  function rec(id, depth) {
    const e = byId.get(id);
    if (!e) return;
    const div = document.createElement('div');
    div.className = 'tree-node';
    if (id === leaf) div.classList.add('current');
    else if (pathIds.has(id)) div.classList.add('onpath');
    div.style.paddingLeft = (6 + depth * 16) + 'px';
    div.innerHTML = '<span class="ico">' + nodeIcon(e) + '</span>' + escapeHtml(nodeLabel(e));
    div.onclick = () => {
      state.currentLeaf = id;
      renderConversation();
      renderTree();
    };
    body.appendChild(div);
    (children.get(id) || []).forEach((c) => rec(c, depth + 1));
  }

  roots.forEach((r) => rec(r, 0));
}

function nodeIcon(e) {
  if (e.type === 'message') {
    const r = e.message && e.message.role;
    if (r === 'user') return '👤';
    if (r === 'assistant') return '🤖';
    if (r === 'toolResult') return '📄';
    if (r === 'system') return '⚙️';
    if (r === 'bashExecution') return '💻';
    return '💬';
  }
  const icons = {
    model_change: '🔄', thinking_level_change: '🧠', compaction: '🗜️',
    branch_summary: '🌿', custom: '🔌', custom_message: '🔌',
    label: '🏷', session_info: '📝', usage: '📊',
  };
  return icons[e.type] || '•';
}

function nodeLabel(e) {
  if (e.type === 'message') {
    const m = e.message || {};
    const r = m.role;
    if (r === 'user') return 'user: ' + truncate(extractText(m.content), 50);
    if (r === 'assistant') {
      const t = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      const tc = (m.content || []).filter((b) => b.type === 'toolCall').length;
      return 'assistant' + (t ? ': ' + truncate(t, 40) : '') + (tc ? ' [' + tc + ' 工具]' : '');
    }
    if (r === 'toolResult') return 'toolResult: ' + (m.toolName || '');
    if (r === 'system') return 'system prompt';
    if (r === 'bashExecution') return 'bash: ' + truncate(m.command || '', 40);
    if (r === 'custom') return 'custom: ' + (m.customType || '');
    return String(r || '');
  }
  if (e.type === 'model_change') return 'model → ' + (e.provider || '') + '/' + (e.modelId || '');
  if (e.type === 'thinking_level_change') return 'thinking: ' + (e.thinkingLevel || '');
  if (e.type === 'compaction') return 'compaction';
  if (e.type === 'branch_summary') return 'branch summary';
  if (e.type === 'label') return 'label: ' + (e.label || '');
  if (e.type === 'session_info') return 'name: ' + (e.name || '');
  return e.type;
}

// ---------------- 导出 HTML ----------------
async function exportHtml() {
  if (!state.session) return;
  let css = '';
  try { css = await (await fetch(apiUrl('style.css'))).text(); } catch (e) { /* 忽略 */ }
  const content = $('#conversation').innerHTML;
  const title = getSessionName(state.session) || 'pi-session';
  const html =
    '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title>\n' +
    '<style>' + css + '</style></head>\n' +
    '<body style="background:#0d1117">\n' +
    '<div id="conversation" style="max-width:900px;margin:0 auto;padding:24px 20px 80px">' + content + '</div>\n' +
    '</body></html>';
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (title.replace(/[\\/:*?"<>|]/g, '_') || 'pi-session') + '.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportMarkdown() {
  if (!state.session) return;
  const { byId } = buildTree(state.session.entries);
  const path = pathToLeaf(byId, state.currentLeaf || state.session.leafId);
  const lines = ['# ' + (getSessionName(state.session) || 'pi-session'), ''];
  for (const e of path) {
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    if (m.role === 'user') {
      const t = extractText(m.content).trim();
      if (t) { lines.push('## 用户', '', t, ''); }
    } else if (m.role === 'assistant') {
      const t = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
      if (t) { lines.push('## 助手', '', t, ''); }
    }
    // 忽略 thinking / 工具细节 / system
  }
  const md = lines.join('\n');
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (getSessionName(state.session) || 'pi-session').replace(/[\\/:*?"<>|]/g, '_') + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------- 统计 --------------
function openStats() {
  const s = state.sessions;
  const totalTokens = s.reduce((a, b) => a + (b.totalTokens || 0), 0);
  const totalCost = s.reduce((a, b) => a + (b.totalCost || 0), 0);
  const totalEntries = s.reduce((a, b) => a + (b.entryCount || 0), 0);

  const labelOf = (x) => {
    if (x.name) return { text: x.name, dim: false };
    if (x.firstUser) return { text: truncate(x.firstUser, 30), dim: false };
    return { text: (x.cwd ? lastSeg(x.cwd) : '未命名会话'), dim: true };
  };

  const byTokens = [...s].sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0))
    .map((x) => { const l = labelOf(x); return { label: l.text, dim: l.dim, value: x.totalTokens || 0 }; });
  const byCost = [...s].sort((a, b) => (b.totalCost || 0) - (a.totalCost || 0))
    .map((x) => { const l = labelOf(x); return { label: l.text, dim: l.dim, value: x.totalCost || 0 }; });

  const dayMap = new Map();
  for (const x of s) {
    if (!x.timestamp) continue;
    const d = String(x.timestamp).slice(0, 10);
    dayMap.set(d, (dayMap.get(d) || 0) + (x.totalTokens || 0));
  }
  const byDay = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, v]) => ({ label: d.slice(5), value: v }));

  let toolStatsHtml = '';
  if (state.session && state.meta && state.meta.toolStats && state.meta.toolStats.length) {
    const rows = state.meta.toolStats.map(([name, st]) =>
      '<tr><td>' + escapeHtml(name) + '</td><td>' + st.calls + '</td>' +
      '<td class="' + (st.errors ? 'err-text' : '') + '">' + st.errors + '</td>' +
      '<td>' + fmtDuration(st.durationMs) + '</td></tr>'
    ).join('');
    toolStatsHtml =
      '<h3>当前会话 · 工具调用统计</h3>' +
      '<table class="tool-stats-table"><thead><tr><th>工具</th><th>调用</th><th>错误</th><th>总耗时</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  $('#statsBody').innerHTML =
    '<div class="stat-cards">' +
      card('会话数', String(s.length)) +
      card('消息条目', fmtTokens(totalEntries)) +
      card('总 Tokens', fmtTokens(totalTokens)) +
      card('总费用', '$' + totalCost.toFixed(2)) +
    '</div>' +
    '<h3>Token 用量（按会话）</h3>' + (byTokens.length ? lineChart(byTokens, { left: byTokens.length + ' 个会话', right: '峰值 ' + fmtTokens(byTokens[0].value) }) : emptyChart()) +
    '<h3>费用（按会话）</h3>' + (byCost.length ? lineChart(byCost, { fmt: fmtCost, unit: '', cls: 'cost', left: byCost.length + ' 个会话', right: '峰值 ' + fmtCost(byCost[0].value) }) : emptyChart()) +
    '<h3>每日 Token 活跃度</h3>' + (byDay.length ? lineChart(byDay) : emptyChart()) +
    toolStatsHtml;

  $('#statsOverlay').classList.remove('hidden');
}

function card(label, value) {
  return '<div class="stat-card"><div class="stat-label">' + escapeHtml(label) + '</div><div class="stat-val">' + value + '</div></div>';
}

function barChart(items, fmt, colorVar) {
  const max = Math.max(1, ...items.map((x) => x.value));
  return items.map((it) => {
    const pct = (it.value / max) * 100;
    const track = it.value > 0
      ? '<div class="bar-track"><div class="bar-fill' + (colorVar ? ' ' + colorVar : '') + (it.hi ? ' hi' : '') + '" style="width:' + pct.toFixed(2) + '%"></div></div>'
      : '';
    return '<div class="bar-row">' +
      '<div class="bar-row-top">' +
        '<span class="bar-label' + (it.dim ? ' dim' : '') + '" title="' + escapeHtml(it.label) + '">' + escapeHtml(truncate(it.label, 40)) + '</span>' +
        '<span class="bar-val">' + fmt(it.value) + '</span>' +
      '</div>' +
      track +
      '</div>';
  }).join('');
}

function emptyChart() {
  return '<p class="dim" style="margin:4px 0">暂无数据</p>';
}

function lineChart(points, opts) {
  if (!points.length) return emptyChart();
  opts = opts || {};
  const fmt = opts.fmt || fmtTokens;
  const unit = opts.unit || ' tokens';
  const cls = opts.cls || '';

  const W = 680, H = 96, PL = 8, PR = 8, PT = 12, PB = 16;
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = points.length;
  const stepX = n > 1 ? (W - PL - PR) / (n - 1) : 0;
  const x = (i) => PL + i * stepX;
  const y = (v) => PT + (1 - v / max) * (H - PT - PB);

  const coords = points.map((p, i) => [x(i), y(p.value)]);
  const line = coords.map((c) => c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' ');
  const area = PL + ',' + (H - PB) + ' ' + line + ' ' + (PL + (n - 1) * stepX).toFixed(1) + ',' + (H - PB);

  const dots = coords.map((c, i) =>
    '<circle cx="' + c[0].toFixed(1) + '" cy="' + c[1].toFixed(1) + '" r="3"><title>' +
    escapeHtml(points[i].label) + ' · ' + fmt(points[i].value) + unit + '</title></circle>'
  ).join('');

  const idxs = n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  const xLabels = idxs.map((i) => '<span>' + escapeHtml(points[i].label) + '</span>').join('');

  const metaLeft = opts.left != null ? opts.left : escapeHtml(points[0].label) + ' → ' + escapeHtml(points[n - 1].label);
  const metaRight = opts.right != null ? opts.right : fmt(points[n - 1].value) + unit;

  return '<div class="line-chart' + (cls ? ' ' + cls : '') + '">' +
    '<div class="lc-meta">' +
      '<span>' + metaLeft + '</span>' +
      '<span>' + metaRight + '</span>' +
    '</div>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" class="lc-svg">' +
      '<polygon points="' + area + '" class="lc-area"></polygon>' +
      '<polyline points="' + line + '" class="lc-line"></polyline>' +
      dots +
    '</svg>' +
    '<div class="lc-xlabels">' + xLabels + '</div>' +
    '</div>';
}

// ---------------- 自动刷新 ----------------
let lastListSig = '';

function listSignature(sessions) {
  return sessions.map((s) => s.file + ':' + s.entryCount + ':' + s.leafId).join('|');
}

async function poll() {
  if (document.hidden) return;
  try {
    const res = await fetch(apiUrl('/api/sessions'));
    const data = await res.json();
    const sig = listSignature(data.sessions || []);
    if (sig === lastListSig) return;
    lastListSig = sig;

    state.sessions = data.sessions || [];
    renderSessionList();
    checkOpenSessionUpdate();
  } catch (e) { /* 轮询失败忽略 */ }
}

function checkOpenSessionUpdate() {
  if (!state.session) return;
  const oldCount = state.session.entries.length;
  const oldLeaf = state.session.leafId;
  const fresh = state.sessions.find((s) => s.file === state.session.file);
  if (!fresh) {
    // 当前会话已被删除
    state.session = null;
    state.currentLeaf = null;
    state.tree = null;
    $('#conversation').classList.add('hidden');
    $('#welcome').classList.remove('hidden');
    $('#treeBtn').classList.add('hidden');
    $('#exportBtn').classList.add('hidden');
    $('#exportMdBtn').classList.add('hidden');
    $('#findInput').classList.add('hidden');
    $('#viewToolbar').classList.add('hidden');
    $('#updatePill').classList.add('hidden');
    return;
  }
  const grew = fresh.entryCount - oldCount;
  if (grew <= 0 && fresh.leafId === oldLeaf) return;

  if (state.autoRefresh) {
    reloadOpenSession();
  } else {
    state.pendingNew = grew > 0 ? grew : 0;
    showPill();
  }
}

async function reloadOpenSession() {
  if (!state.session) return;
  const file = state.session.file;
  const wasTip = state.currentLeaf == null || state.currentLeaf === state.session.leafId;
  const keepLeaf = state.currentLeaf;
  try {
    const res = await fetch(apiUrl('/api/session?file=' + encodeURIComponent(file)));
    if (!res.ok) return;
    const s = await res.json();
    const stillExists = s.entries.some((e) => e.id === keepLeaf);
    if (wasTip) state.currentLeaf = s.leafId;
    else if (stillExists) state.currentLeaf = keepLeaf;
    else state.currentLeaf = s.leafId;

    const scrollTop = $('#main').scrollTop;
    state.session = s;
    state.meta = computeMeta(s);
    populateToolFilter();
    renderConversation();
    $('#main').scrollTop = scrollTop;
    if (state.treeMode) renderTree();
  } catch (e) { /* 忽略 */ }
}

function showPill() {
  $('#updatePillCount').textContent = state.pendingNew ? '（新增 ' + state.pendingNew + ' 条）' : '';
  $('#updatePill').classList.remove('hidden');
}

// 每天定时刷新两次（本地时间 HH:mm），改这里即可
const POLL_TIMES = ['09:00', '21:00'];

function scheduleNextPoll() {
  const now = new Date();
  let next = null;
  for (const t of POLL_TIMES) {
    const parts = String(t).split(':').map(Number);
    if (parts.length !== 2) continue;
    const d = new Date(now);
    d.setHours(parts[0], parts[1], 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    if (!next || d < next) next = d;
  }
  if (!next) return;
  const delay = Math.max(1000, next - now);
  setTimeout(() => { poll(); scheduleNextPoll(); }, delay);
}

async function manualRefresh() {
  await poll();
  if (state.session) {
    $('#updatePill').classList.add('hidden');
    await reloadOpenSession();
  }
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $('#sessionSearch').addEventListener('input', renderSessionList);
  $('#sortSelect').addEventListener('change', (ev) => {
    state.sortMode = ev.target.value;
    renderSessionList();
  });
  $('#roleFilter').addEventListener('change', (ev) => {
    state.roleFilter = ev.target.value;
    renderConversation();
  });
  $('#toolFilter').addEventListener('change', (ev) => {
    state.toolFilter = ev.target.value;
    renderConversation();
  });

  $('#treeBtn').addEventListener('click', () => {
    state.treeMode = !state.treeMode;
    $('#treePanel').classList.toggle('hidden', !state.treeMode);
    if (state.treeMode) renderTree();
  });

  $('#treeClose').addEventListener('click', () => {
    state.treeMode = false;
    $('#treePanel').classList.add('hidden');
  });

  let findTimer;
  $('#findInput').addEventListener('input', (ev) => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => {
      state.findQuery = ev.target.value;
      renderConversation();
    }, 250);
  });

  $('#exportBtn').addEventListener('click', exportHtml);
  $('#exportMdBtn').addEventListener('click', exportMarkdown);

  $('#updatePill').addEventListener('click', () => {
    $('#updatePill').classList.add('hidden');
    reloadOpenSession();
  });

  $('#autoRefreshChk').addEventListener('change', (ev) => {
    state.autoRefresh = ev.target.checked;
    $('#updatePill').classList.add('hidden');
    if (state.autoRefresh) reloadOpenSession();
  });

  $('#refreshBtn').addEventListener('click', manualRefresh);

  $('#errorsOnlyChk').addEventListener('change', (ev) => {
    state.errorsOnly = ev.target.checked;
    renderConversation();
  });
  $('#toggleThinkingBtn').addEventListener('click', () => {
    const items = [...document.querySelectorAll('details.thinking-block')];
    const anyOpen = items.some((d) => d.open);
    items.forEach((d) => { d.open = !anyOpen; });
  });
  $('#toggleResultsBtn').addEventListener('click', () => {
    const items = [...document.querySelectorAll('.tl-tool-result')];
    const anyOpen = items.some((el) => !el.classList.contains('tr-collapsed'));
    items.forEach((el) => {
      el.classList.toggle('tr-collapsed', anyOpen);
      const chev = el.querySelector('.tr-chev');
      if (chev) chev.textContent = anyOpen ? '▸' : '▾';
    });
  });

  $('#statsBtn').addEventListener('click', openStats);
  $('#statsClose').addEventListener('click', () => $('#statsOverlay').classList.add('hidden'));
  $('#statsOverlay').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) $('#statsOverlay').classList.add('hidden');
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') $('#statsOverlay').classList.add('hidden');
  });

  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
      if (!state.session) return;
      ev.preventDefault();
      $('#findInput').focus();
    }
  });

  // 键盘导航：j/k 跳转消息，Enter 展开/折叠，/ 聚焦搜索
  document.addEventListener('keydown', (ev) => {
    if (!state.session) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.key === '/') { ev.preventDefault(); $('#findInput').focus(); return; }
    if (ev.key === 'j' || ev.key === 'k') {
      ev.preventDefault();
      const nodes = [...document.querySelectorAll('#conversation .tl-node')].filter((n) => n.offsetParent !== null);
      if (!nodes.length) return;
      const cur = nodes.findIndex((n) => n.classList.contains('kb-current'));
      const delta = ev.key === 'j' ? 1 : -1;
      const next = cur === -1 ? (delta === 1 ? 0 : nodes.length - 1) : Math.min(nodes.length - 1, Math.max(0, cur + delta));
      nodes.forEach((n) => n.classList.remove('kb-current'));
      nodes[next].classList.add('kb-current');
      nodes[next].scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (ev.key === 'Enter') {
      const cur = document.querySelector('#conversation .tl-node.kb-current');
      if (cur) {
        const d = cur.querySelector('details.collapse, details.tl-tc-details');
        if (d) d.open = !d.open;
      }
    }
  });
}

// ---------------- 启动 ----------------
bindEvents();
loadRenames();
loadSessions();
scheduleNextPoll();
