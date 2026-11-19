const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PORT = Number(process.env.PORT || 4173);

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('ไม่พบ DISCORD_BOT_TOKEN ในไฟล์ .env');
  if (!fs.existsSync(EVENTS_FILE) || !fs.existsSync(CONFIG_FILE)) throw new Error('ยังไม่พบข้อมูลเดิม ให้เปิด RakWebDrop และรับข้อความจาก AA Script Hook ก่อน');

  const events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const known = new Map();
  for (const event of events) {
    if (event.sender !== 'AA Script Hook') continue;
    const channelId = event.payload?.channel;
    const authorId = event.payload?.author?.id;
    if (typeof channelId !== 'string' || !authorId) continue;
    if (!known.has(channelId)) known.set(channelId, new Set());
    known.get(channelId).add(authorId);
  }
  if (!known.size) throw new Error('ไม่พบ channel ID ของ AA Script Hook ในข้อมูลเดิม');

  let added = 0;
  let refreshed = 0;
  for (const [channelId, authorIds] of known) {
    const historyResponse = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (historyResponse.status === 401) throw new Error('Discord ไม่ยอมรับโทเคนบอต ตรวจไฟล์ .env');
    if (historyResponse.status === 403) throw new Error('บอตไม่มีสิทธิ์ View Channel และ Read Message History ในช่อง AA Script Hook');
    if (!historyResponse.ok) throw new Error(`Discord ตอบกลับ HTTP ${historyResponse.status} ขณะอ่านประวัติ`);

    const history = await historyResponse.json();
    const matches = history
      .filter(message => authorIds.has(message.author?.id))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    for (const message of matches) {
      const payload = {
        event: 'MESSAGE_BACKFILL',
        source: 'Discord',
        message_id: message.id,
        channel: message.channel_id,
        guild_id: message.guild_id,
        timestamp: message.timestamp,
        author: { id: message.author.id, username: message.author.global_name || message.author.username || 'AA Script Hook' },
        content: message.content,
        attachments: message.attachments,
        embeds: message.embeds,
      };
      const endpoint = `http://127.0.0.1:${PORT}/webhook/${config.secret}`;
      const body = JSON.stringify(payload);
      let response = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      if (response.status === 404) response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!response.ok) throw new Error(`RakWebDrop ตอบกลับ HTTP ${response.status}; ตรวจว่าเปิด node start.js อยู่`);
      if (events.some(event => event.payload?.message_id === message.id)) refreshed++;
      else added++;
    }
    console.log(`ช่องที่บันทึกไว้ ${channelId}: พบข้อความจาก AA Script Hook ${matches.length} รายการ (ตรวจย้อนหลังไม่เกิน 100 ข้อความ)`);
  }
  console.log(`เสร็จแล้ว: เพิ่ม ${added} รายการ และอัปเดต ${refreshed} รายการ`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
