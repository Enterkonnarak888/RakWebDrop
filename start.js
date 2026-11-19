const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = __dirname;
const receiverUrl = `http://127.0.0.1:${process.env.PORT || 4173}/health`;
let serverProcess = null;
let botProcess = null;
let stopping = false;

async function receiverIsRunning() {
  try { return (await fetch(receiverUrl, { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
}
function startChild(file) {
  return spawn(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, stdio: 'inherit', env: process.env });
}
async function waitForReceiver() {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await receiverIsRunning()) return true;
    if (serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined) return false;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping RakWebDrop and Discord bot...');
  botProcess?.kill();
  serverProcess?.kill();
  setTimeout(() => process.exit(0), 500);
}
function startBot() {
  botProcess = startChild('discord-bot.js');
  botProcess.once('exit', code => {
    if (stopping) return;
    if (code === 1) {
      console.error('Bot stopped. Fix the token or Discord intent settings, then run node start.js again.');
      shutdown();
      return;
    }
    console.log('Bot stopped unexpectedly; restarting in 3 seconds...');
    setTimeout(() => { if (!stopping) startBot(); }, 3000);
  });
}

async function main() {
  if (!await receiverIsRunning()) {
    console.log('Starting RakWebDrop website...');
    serverProcess = startChild('server.js');
    serverProcess.on('exit', (code) => {
      if (!stopping && code !== 0) console.error(`Website stopped (exit ${code}).`);
    });
    if (!await waitForReceiver()) {
      console.error('Website did not start. Check the message above and try again.');
      shutdown();
      return;
    }
  } else {
    console.log('RakWebDrop website is already running.');
  }
  console.log('Starting Discord bot...');
  startBot();
  console.log('Keep this window open. Open http://localhost:4173 to view the website. Press Ctrl+C to stop.');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch(error => { console.error(error.message); shutdown(); });
