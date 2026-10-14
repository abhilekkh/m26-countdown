// M# 2026 countdown: display (/) + remote admin (/admin), live updates over Server-Sent Events.
// Zero dependencies. Env: PORT, ADMIN_PIN, DATA_DIR.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const PIN = String(process.env.ADMIN_PIN || 'changeme');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'state.json');
const PUB = path.join(__dirname, 'public');

const DEFAULT = {
  v: 0,
  theme: 'dark',
  headline: '',            // overrides the schedule title in live mode when set
  footer: true,            // show "Up next" pill in live mode
  rotate: 9,               // seconds per announcement when several are active
  timer: { mode: 'auto', title: '', total: 0, endAt: 0, paused: false, rem: 0 },
  ann: []                  // {id, text, until (epoch ms, 0 = until removed), at}
};

let state = structuredClone(DEFAULT);
try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}

let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state)); } catch (e) { console.error('save failed', e.message); }
  }, 100);
}

const clients = new Set();
const payload = () => JSON.stringify({ state, now: Date.now() });
function broadcast() {
  const msg = `data: ${payload()}\n\n`;
  for (const res of clients) res.write(msg);
}
function commit() { state.v++; save(); broadcast(); }

// Drop expired announcements
setInterval(() => {
  const n = Date.now(), before = state.ann.length;
  state.ann = state.ann.filter(a => !a.until || a.until > n);
  if (state.ann.length !== before) commit();
}, 15000);
// Keep SSE connections (and proxies) alive
setInterval(() => { for (const res of clients) res.write(`: ping ${Date.now()}\n\n`); }, 20000);

const str = (x, max) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const int = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.round(+x || 0)));

function act(a) {
  const t = state.timer, now = Date.now();
  switch (a.type) {
    case 'ann.add': {
      const text = str(a.text, 160);
      if (!text) throw new Error('Announcement text is empty');
      const m = int(a.minutes, 0, 24 * 60);
      state.ann.push({ id: crypto.randomUUID(), text, until: m ? now + m * 60000 : 0, at: now });
      break;
    }
    case 'ann.remove': state.ann = state.ann.filter(x => x.id !== a.id); break;
    case 'ann.clear': state.ann = []; break;
    case 'timer.auto': state.timer = { ...t, mode: 'auto', paused: false }; break;
    case 'timer.start': {
      const total = (int(a.hours, 0, 99) * 60 + int(a.minutes, 0, 59)) * 60000 + int(a.seconds, 0, 59) * 1000;
      if (!total) throw new Error('Duration must be above zero');
      state.timer = { mode: 'manual', title: str(a.title, 80), total, endAt: now + total, paused: false, rem: total };
      break;
    }
    case 'timer.title': t.title = str(a.title, 80); break;
    case 'timer.pause':
      if (t.mode === 'manual' && !t.paused) { t.rem = Math.max(0, t.endAt - now); t.paused = true; }
      break;
    case 'timer.resume':
      if (t.mode === 'manual' && t.paused) { t.endAt = now + t.rem; t.paused = false; }
      break;
    case 'timer.adjust': {
      if (t.mode !== 'manual') throw new Error('Adjust works on a custom timer');
      const d = int(a.minutes, -600, 600) * 60000;
      if (t.paused) t.rem = Math.max(0, t.rem + d); else t.endAt = Math.max(now, t.endAt + d);
      const left = t.paused ? t.rem : t.endAt - now;
      t.total = Math.max(t.total, left, 1);
      break;
    }
    case 'timer.reset':
      if (t.mode !== 'manual') throw new Error('Reset works on a custom timer');
      t.endAt = now + t.total; t.rem = t.total; t.paused = false;
      break;
    case 'settings':
      if (a.theme === 'dark' || a.theme === 'light') state.theme = a.theme;
      if ('headline' in a) state.headline = str(a.headline, 80);
      if ('footer' in a) state.footer = !!a.footer;
      if ('rotate' in a) state.rotate = int(a.rotate, 3, 60);
      break;
    default: throw new Error('Unknown action');
  }
  commit();
}

// Basic brute-force guard: per-IP failure counter
const fails = new Map();
function authed(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const f = fails.get(ip) || { n: 0, t: 0 };
  if (f.n >= 10 && Date.now() - f.t < 5 * 60000) return 'locked';
  const got = Buffer.from(String(req.headers['x-admin-pin'] || '')), want = Buffer.from(PIN);
  const ok = got.length === want.length && crypto.timingSafeEqual(got, want);
  if (ok) fails.delete(ip); else fails.set(ip, { n: f.n + 1, t: Date.now() });
  return ok;
}

function body(req) {
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e5) { rej(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { rej(new Error('Bad JSON')); } });
  });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };
const ROUTES = { '/': 'display.html', '/display': 'display.html', '/admin': 'admin.html' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  try {
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 2000\ndata: ${payload()}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/time') return json(res, 200, { now: Date.now() });
    if (p === '/api/state') return json(res, 200, JSON.parse(payload()));
    if (p === '/health') return json(res, 200, { ok: true, clients: clients.size });
    if (req.method === 'POST' && (p === '/api/login' || p === '/api/action')) {
      const ok = authed(req);
      if (ok === 'locked') return json(res, 429, { error: 'Too many wrong PINs. Wait 5 minutes.' });
      if (!ok) return json(res, 401, { error: 'Wrong PIN' });
      if (p === '/api/login') return json(res, 200, { ok: true });
      try { act(await body(req)); } catch (e) { return json(res, 400, { error: e.message }); }
      return json(res, 200, JSON.parse(payload()));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    const file = path.join(PUB, ROUTES[p] || path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUB + path.sep)) return json(res, 404, { error: 'Not found' });
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { error: 'Not found' });
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => {
  console.log(`Display: http://localhost:${PORT}/   Admin: http://localhost:${PORT}/admin`);
  if (PIN === 'changeme') console.warn('ADMIN_PIN not set; using default "changeme"');
});
