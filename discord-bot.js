const fs = require('node:fs');
const path = require('node:path');

// Read a local .env without a package dependency. The token stays on this machine.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const token = process.env.DISCORD_BOT_TOKEN;
const notificationUserId = process.env.DISCORD_NOTIFY_USER_ID || '';
const port = Number(process.env.PORT || 4173);
const configPath = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'config.json');
if (!token) {
  console.error('Missing DISCORD_BOT_TOKEN. Add your bot token to .env first.');
  process.exit(1);
}
if (typeof WebSocket === 'undefined') {
  console.error('This bot bridge needs Node.js 22 or newer (built-in WebSocket).');
  process.exit(1);
}

const INTENTS = (1 << 0) | (1 << 9) | (1 << 15); // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT
let gatewayUrl;
let sessionId = null;
let sequence = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let socket = null;
let botUserId = null;
let heartbeatAck = true;
let stopped = false;
let retryCount = 0;
const knownMessageIds = new Set();
let historySyncPromise = Promise.resolve();

function log(message) { console.log(`[RakWebDrop Discord] ${message}`); }
function send(op, d) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op, d }));
}
function clearHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}
function reconnect(reason) {
  if (stopped) return;
  clearHeartbeat();
  log(`${reason}; reconnecting`);
  try { socket?.close(); } catch {}
  const delay = Math.min(1000 * 2 ** retryCount, 30000) + Math.floor(Math.random() * 900);
  retryCount = Math.min(retryCount + 1, 5);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}
async function forwardMessage(message, eventType) {
  const secret = JSON.parse(fs.readFileSync(configPath, 'utf8')).secret;
  const payload = {
    event: eventType,
    source: 'Discord',
    message_id: message.id,
    channel: message.channel_id,
    guild_id: message.guild_id,
    timestamp: message.timestamp,
  };
  if (message.author) payload.author = { id: message.author.id, username: message.author.global_name || message.author.username || 'Discord user' };
  if (Object.hasOwn(message, 'content')) payload.content = message.content;
  if (Object.hasOwn(message, 'attachments')) payload.attachments = message.attachments;
  if (Object.hasOwn(message, 'embeds')) payload.embeds = message.embeds;
  const endpoint = `http://127.0.0.1:${port}/webhook/${secret}`;
  const body = JSON.stringify(payload);
  const sendPayload = method => fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body });
  let response = await sendPayload(eventType === 'MESSAGE_UPDATE' ? 'PUT' : 'POST');
  // Older running website processes only know POST; fall back so edits still appear there.
  if (eventType === 'MESSAGE_UPDATE' && response.status === 404) response = await sendPayload('POST');
  if (!response.ok) throw new Error(`RakWebDrop receiver returned HTTP ${response.status}`);
  log(`forwarded ${eventType} from channel ${message.channel_id}${message.content ? ` (${message.content.length} text characters)` : ' (embed/attachment or empty text)'}`);
}
async function notifyDungeonDefeat(message) {
  if (!/^\d{17,20}$/.test(notificationUserId) || !message.channel_id) return;
  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  const isAnimeAdventures = embeds.some(embed => String(embed.title || '').trim().toLowerCase() === 'anime adventures');
  if (!isAnimeAdventures) return;
  const resultField = embeds.flatMap(embed => embed.fields || []).find(field => /^match\s*result$/i.test(String(field.name || '').trim()));
  const result = String(resultField?.value || '');
  if (!/\bdungeon\s+room\b/i.test(result) || /\binfinite\s+mode\b/i.test(result) || !/\b(defeat|defeated|loss|lost)\b/i.test(result)) return;

  const depth = result.match(/\bDepth\s*[:#-]?\s*(\d+)\b/i)?.[1];
  const detail = depth ? ` (Depth ${depth})` : '';
  const response = await fetch(`https://discord.com/api/v10/channels/${message.channel_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `<@${notificationUserId}> แพ้ Dungeon Room${detail}`,
      allowed_mentions: { parse: [], users: [notificationUserId] },
    }),
  });
  if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}; check the bot's Send Messages permission`);
  log(`sent Dungeon Room defeat notification in channel ${message.channel_id}`);
}
async function backfillRecentMessages() {
  const secret = JSON.parse(fs.readFileSync(configPath, 'utf8')).secret;
  const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
    headers: { 'x-rakwebdrop-internal': secret },
  });
  if (!response.ok) throw new Error(`could not read saved events (HTTP ${response.status})`);
  const events = await response.json();
  const targets = new Map();

  for (const event of events) {
    const payload = event.payload || {};
    if (payload.message_id) knownMessageIds.add(String(payload.message_id));
    const channelId = payload.channel;
    const authorId = payload.author?.id;
    const isAnimeAdventures = Array.isArray(payload.embeds) && payload.embeds.some(embed =>
      String(embed.title || '').trim().toLowerCase() === 'anime adventures');
    if (!channelId || !authorId || !isAnimeAdventures || !payload.message_id) continue;

    const key = String(channelId);
    if (!targets.has(key)) targets.set(key, { authorIds: new Set(), latestMessageId: String(payload.message_id) });
    const target = targets.get(key);
    target.authorIds.add(String(authorId));
    if (BigInt(payload.message_id) > BigInt(target.latestMessageId)) target.latestMessageId = String(payload.message_id);
  }

  let recovered = 0;
  for (const [channelId, target] of targets) {
    const originalCursor = BigInt(target.latestMessageId);
    const fetchedMessages = new Map();
    const firstUrl = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
    firstUrl.searchParams.set('after', originalCursor.toString());
    firstUrl.searchParams.set('limit', '100');
    const firstResponse = await fetch(firstUrl, { headers: { Authorization: `Bot ${token}` } });
    if (!firstResponse.ok) {
      log(`history check unavailable for channel ${channelId} (HTTP ${firstResponse.status}); check View Channel and Read Message History permissions`);
      continue;
    }
    const firstPage = await firstResponse.json();
    if (!Array.isArray(firstPage) || firstPage.length === 0) continue;
    for (const message of firstPage) fetchedMessages.set(String(message.id), message);

    // Discord returns messages newest first. If more than 100 arrived while offline,
    // page backward from the oldest returned message until reaching our saved cursor.
    let beforeId = firstPage.reduce((oldest, message) => BigInt(message.id) < oldest ? BigInt(message.id) : oldest, BigInt(firstPage[0].id));
    for (let page = 1; firstPage.length === 100 && page < 10; page += 1) {
      const pageUrl = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
      pageUrl.searchParams.set('before', beforeId.toString());
      pageUrl.searchParams.set('limit', '100');
      const pageResponse = await fetch(pageUrl, { headers: { Authorization: `Bot ${token}` } });
      if (!pageResponse.ok) {
        log(`history pagination stopped for channel ${channelId} (HTTP ${pageResponse.status})`);
        break;
      }
      const olderPage = await pageResponse.json();
      if (!Array.isArray(olderPage) || olderPage.length === 0) break;
      for (const message of olderPage) {
        if (BigInt(message.id) > originalCursor) fetchedMessages.set(String(message.id), message);
      }
      const oldestId = olderPage.reduce((oldest, message) => BigInt(message.id) < oldest ? BigInt(message.id) : oldest, BigInt(olderPage[0].id));
      if (oldestId <= originalCursor || olderPage.length < 100) break;
      beforeId = oldestId;
    }

    const orderedMessages = [...fetchedMessages.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
    for (const message of orderedMessages) {
      const messageId = String(message.id);
      if (BigInt(messageId) <= originalCursor || !target.authorIds.has(String(message.author?.id)) || knownMessageIds.has(messageId)) continue;
      await forwardMessage(message, 'MESSAGE_CREATE');
      knownMessageIds.add(messageId);
      recovered += 1;
    }
  }
  log(`history check complete; recovered ${recovered} missed Anime Adventures message(s)`);
}
async function handleDispatch(packet) {
  if (packet.s !== null && packet.s !== undefined) sequence = packet.s;
  if (packet.t === 'READY') {
    sessionId = packet.d.session_id;
    botUserId = packet.d.user.id;
    retryCount = 0;
    log(`connected as ${packet.d.user.username}`);
    historySyncPromise = backfillRecentMessages().catch(error => log(`history check failed: ${error.message}`));
  }
  if ((packet.t === 'MESSAGE_CREATE' || packet.t === 'MESSAGE_UPDATE') && packet.d.author?.id !== botUserId) {
    try {
      await historySyncPromise;
      const messageId = String(packet.d.id || '');
      if (packet.t === 'MESSAGE_CREATE' && messageId && knownMessageIds.has(messageId)) return;
      await forwardMessage(packet.d, packet.t);
      if (messageId) knownMessageIds.add(messageId);
      if (packet.t === 'MESSAGE_CREATE') {
        try { await notifyDungeonDefeat(packet.d); }
        catch (error) { log(`could not send Dungeon Room notification: ${error.message}`); }
      }
    }
    catch (error) { log(`could not forward message: ${error.message}`); }
  }
}
async function connect() {
  if (stopped) return;
  try {
    if (!gatewayUrl) {
      const response = await fetch('https://discord.com/api/v10/gateway/bot', { headers: { Authorization: `Bot ${token}` } });
      if (response.status === 401 || response.status === 403) {
        console.error(`Discord rejected the bot token (HTTP ${response.status}). Reset the token in the Developer Portal, update .env, then start this script again.`);
        process.exit(1);
      }
      if (!response.ok) throw new Error(`Discord gateway lookup returned HTTP ${response.status}`);
      gatewayUrl = (await response.json()).url;
    }
    socket = new WebSocket(`${gatewayUrl}?v=10&encoding=json`);
    socket.addEventListener('message', event => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.op === 10) {
        const interval = packet.d.heartbeat_interval;
        clearHeartbeat();
        heartbeatAck = true;
        heartbeatTimer = setInterval(() => {
          if (!heartbeatAck) return reconnect('heartbeat acknowledgement missed');
          heartbeatAck = false;
          send(1, sequence);
        }, interval);
        if (sessionId && sequence !== null) send(6, { token, session_id: sessionId, seq: sequence });
        else send(2, { token, intents: INTENTS, properties: { os: process.platform, browser: 'bluedrop', device: 'bluedrop' } });
      } else if (packet.op === 11) {
        heartbeatAck = true;
      } else if (packet.op === 0) {
        handleDispatch(packet);
      } else if (packet.op === 1) {
        send(1, sequence);
      } else if (packet.op === 7) {
        reconnect('Discord requested a reconnect');
      } else if (packet.op === 9) {
        if (!packet.d) { sessionId = null; sequence = null; }
        reconnect('Discord invalidated the session');
      }
    });
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', event => {
      clearHeartbeat();
      if (event.code === 4014) {
        console.error('Discord rejected a Gateway intent. Enable Message Content Intent in the Developer Portal, then start the bot again.');
        process.exit(1);
      }
      if (!stopped && !reconnectTimer) reconnect(`connection closed (${event.code})`);
    });
  } catch (error) {
    reconnect(error.message);
  }
}

process.on('SIGINT', () => { stopped = true; clearHeartbeat(); clearTimeout(reconnectTimer); socket?.close(); process.exit(0); });
process.on('SIGTERM', () => { stopped = true; clearHeartbeat(); clearTimeout(reconnectTimer); socket?.close(); process.exit(0); });
if (!fs.existsSync(configPath)) {
  console.error('RakWebDrop server is not initialized. Start node server.js first.');
  process.exit(1);
}
log('starting; waiting for Discord Gateway');
connect();
