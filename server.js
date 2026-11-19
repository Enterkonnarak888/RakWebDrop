const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PORT = Number(process.env.PORT || 4173);
// Bind to the local network so trusted devices (such as the user's phone) can connect.
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 256 * 1024;
fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }
function makeSecret() { return crypto.randomBytes(24).toString('hex'); }
let config = readJson(CONFIG_FILE, { secret: makeSecret(), createdAt: new Date().toISOString() });
let events = readJson(EVENTS_FILE, []);
saveJson(CONFIG_FILE, config);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || config.secret;
const SESSION_COOKIE = 'rakwebdrop_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

if (process.env.RAILWAY_PUBLIC_DOMAIN && !DASHBOARD_PASSWORD) {
  console.error('DASHBOARD_PASSWORD is required before exposing RakWebDrop to the internet.');
  process.exit(1);
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieValue(req, name) {
  const prefix = `${name}=`;
  const item = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : '';
}
function hasDashboardSession(req) {
  if (!DASHBOARD_PASSWORD) return true;
  const [expires, signature] = cookieValue(req, SESSION_COOKIE).split('.');
  if (!/^\d+$/.test(expires || '') || Number(expires) <= Date.now() || !signature) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(expires).digest('base64url');
  return safeEqualText(signature, expected);
}
function isTrustedLocalBotRequest(req) {
  const address = req.socket.remoteAddress || '';
  const isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  return isLocal && safeEqualText(req.headers['x-rakwebdrop-internal'], config.secret);
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function requestBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function text(value) { return typeof value === 'string' ? value : ''; }
function summarize(payload) {
  const embed = Array.isArray(payload.embeds) ? payload.embeds[0] : null;
  const author = payload.author || payload.user || payload.member?.user || {};
  const channel = payload.channel || payload.channel_name || '';
  const content = payload.content || payload.message?.content || payload.text || embed?.description || embed?.title || '';
  return {
    source: text(payload.event || payload.type || payload.source || payload.t || 'Discord event'),
    sender: text(author.username || author.global_name || payload.username || payload.sender || ''),
    channel: text(typeof channel === 'string' ? channel : channel?.name || ''),
    summary: text(content).slice(0, 300) || 'ได้รับข้อมูล JSON',
  };
}
function addEvent(payload, status = 'received') {
  const meta = summarize(payload);
  const event = { id: crypto.randomUUID(), receivedAt: new Date().toISOString(), status, ...meta, payload };
  events.unshift(event);
  events = events.slice(0, 1000);
  saveJson(EVENTS_FILE, events);
  return event;
}
function updateEvent(payload) {
  const previous = events.find(event => event.payload?.message_id === payload.message_id);
  if (!previous) return addEvent(payload);
  const mergedPayload = { ...previous.payload, ...payload };
  const event = {
    ...previous,
    ...summarize(mergedPayload),
    receivedAt: new Date().toISOString(),
    status: 'received',
    payload: mergedPayload,
  };
  events = [event, ...events.filter(item => item.id !== previous.id)];
  saveJson(EVENTS_FILE, events);
  return event;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/session') {
    return send(res, 200, { authenticated: hasDashboardSession(req) });
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    try {
      const body = await requestBody(req);
      if (!DASHBOARD_PASSWORD || !safeEqualText(body.password, DASHBOARD_PASSWORD)) {
        return send(res, 401, { error: 'รหัสผ่านไม่ถูกต้อง' });
      }
      const expires = String(Date.now() + SESSION_TTL_SECONDS * 1000);
      const signature = crypto.createHmac('sha256', SESSION_SECRET).update(expires).digest('base64url');
      const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${expires}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`);
      return send(res, 200, { authenticated: true });
    } catch (error) {
      return send(res, error.status || 400, { error: 'กรุณาส่งรหัสผ่านที่ถูกต้อง' });
    }
  }
  const webhookRequest = url.pathname.startsWith('/webhook/');
  const pageRequest = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html');
  const localBotRequest = req.method === 'GET' && url.pathname === '/api/events' && isTrustedLocalBotRequest(req);
  const authRequest = req.method === 'GET' && url.pathname === '/api/session' || req.method === 'POST' && url.pathname === '/api/login';
  if (DASHBOARD_PASSWORD && !hasDashboardSession(req) && !webhookRequest && !pageRequest && !localBotRequest && !authRequest) {
    return send(res, 401, { error: 'กรุณาเข้าสู่ระบบก่อน' });
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, { endpoint: `http://${req.headers.host || `localhost:${PORT}`}/webhook/${config.secret}`, enabled: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/events') return send(res, 200, events);
  if (req.method === 'POST' && url.pathname === '/api/import') {
    try {
      const body = await requestBody(req, 10 * 1024 * 1024);
      const imported = Array.isArray(body) ? body : body.events;
      if (!Array.isArray(imported) || imported.length > 1000 || imported.some(item => !item || typeof item !== 'object' || !item.payload || typeof item.payload !== 'object')) {
        return send(res, 400, { error: 'ไฟล์สำรองไม่ใช่รายการข้อมูล RakWebDrop ที่ถูกต้อง' });
      }
      const combined = [...events, ...imported].sort((a, b) => new Date(b.receivedAt || b.payload?.timestamp || 0) - new Date(a.receivedAt || a.payload?.timestamp || 0));
      const seenIds = new Set();
      const seenMessages = new Set();
      events = combined.filter(item => {
        const messageId = item.payload?.message_id ? String(item.payload.message_id) : '';
        if (item.id && seenIds.has(item.id)) return false;
        if (messageId && seenMessages.has(messageId)) return false;
        if (item.id) seenIds.add(item.id);
        if (messageId) seenMessages.add(messageId);
        return true;
      }).slice(0, 1000);
      saveJson(EVENTS_FILE, events);
      return send(res, 200, { imported: events.length });
    } catch (error) {
      return send(res, error.status || 400, { error: error.status === 413 ? 'ไฟล์สำรองมีขนาดใหญ่เกินไป' : 'อ่านไฟล์สำรองไม่สำเร็จ' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/test') {
    const event = addEvent({ event: 'ทดสอบระบบ', username: 'RakWebDrop', channel: 'ส่วนตัว', content: 'Webhook พร้อมรับข้อมูลแล้ว ✨', test: true });
    return send(res, 201, event);
  }
  if (req.method === 'POST' && url.pathname === '/api/message') {
    try {
      const body = await requestBody(req);
      const content = text(body.content).trim();
      if (!content) return send(res, 400, { error: 'กรุณาพิมพ์ข้อความก่อนส่ง' });
      if (content.length > 2000) return send(res, 413, { error: 'ข้อความยาวเกิน 2,000 ตัวอักษร' });
      const event = addEvent({ event: 'ข้อความจากหน้าเว็บ', username: 'RakWebDrop', channel: 'RakWebDrop', content, manual: true });
      return send(res, 201, event);
    } catch (error) {
      return send(res, error.status || 400, { error: error.status === 413 ? 'ข้อมูลเกินขนาดที่กำหนด' : 'กรุณาส่งข้อความที่ถูกต้อง' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/rotate') {
    config = { ...config, secret: makeSecret(), rotatedAt: new Date().toISOString() };
    saveJson(CONFIG_FILE, config);
    return send(res, 200, { endpoint: `http://${req.headers.host || `localhost:${PORT}`}/webhook/${config.secret}` });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/events') { events = []; saveJson(EVENTS_FILE, events); return send(res, 200, { ok: true }); }
  const eventMatch = url.pathname.match(/^\/api\/events\/([\w-]+)$/);
  if (req.method === 'DELETE' && eventMatch) {
    events = events.filter(event => event.id !== eventMatch[1]); saveJson(EVENTS_FILE, events); return send(res, 200, { ok: true });
  }
  const webhookMatch = url.pathname.match(/^\/webhook\/([a-f0-9]+)$/);
  if ((req.method === 'POST' || req.method === 'PUT') && webhookMatch) {
    const supplied = Buffer.from(webhookMatch[1]);
    const expected = Buffer.from(config.secret);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(res, 401, { error: 'Invalid webhook secret' });
    try {
      const payload = await requestBody(req);
      const event = req.method === 'PUT' ? updateEvent(payload) : addEvent(payload);
      return send(res, 202, { ok: true, id: event.id });
    } catch (error) { return send(res, error.status || 400, { error: error.status === 413 ? 'Payload exceeds 256 KB limit' : 'Expected a valid JSON object' }); }
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const page = fs.readFileSync(path.join(ROOT, 'index.html'));
    return send(res, 200, page, 'text/html; charset=utf-8');
  }
  return send(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => console.log(`RakWebDrop is ready at http://${HOST}:${PORT}`));
