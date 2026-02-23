/**
 * Baileys PoC: Validates that we can get engagement-like data (userReceipt, reactions)
 * without a browser. Run: npm install @whiskeysockets/baileys && node scripts/baileys-poc.js
 *
 * Usage:
 *   node scripts/baileys-poc.js
 *   node scripts/baileys-poc.js --group "Your Group Name"   # optional: filter by group name
 *
 * On first run you'll get a QR code; scan with WhatsApp → Linked devices.
 * After connection, history sync runs. We log how many "from me" group messages
 * have userReceipt and reactions. This tells us if Baileys is viable for GroupIQ.
 */

const path = require('path');
const fs = require('fs');

// Baileys is optional for the main app; install with: npm install @whiskeysockets/baileys
let makeWASocket, useMultiFileAuthState, DisconnectReason, delay;
try {
  const baileys = require('@whiskeysockets/baileys');
  makeWASocket = baileys.makeWASocket;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  delay = baileys.delay;
} catch (e) {
  console.error('Missing @whiskeysockets/baileys. Run: npm install @whiskeysockets/baileys');
  process.exit(1);
}

const QRCode = require('qrcode');
const authDir = path.join(__dirname, '..', 'baileys_auth_poc');
const qrHtmlPath = path.join(__dirname, '..', 'baileys-qr.html');

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function getReadCount(userReceipt) {
  if (!Array.isArray(userReceipt)) return 0;
  return userReceipt.filter((r) => r && (r.readTimestamp || r.receiptTimestamp)).length;
}

function getReactionCount(reactions) {
  if (!Array.isArray(reactions)) return 0;
  let n = 0;
  for (const r of reactions) {
    if (r && r.count) n += Number(r.count);
    else if (r) n += 1;
  }
  return n;
}

function hasReply(msg) {
  const ext = msg?.extendedTextMessage || msg?.conversation;
  if (!ext) return false;
  const ctx = ext.contextInfo;
  return !!(ctx && (ctx.stanzaId || ctx.quotedMessage));
}

async function main() {
  const filterGroupName = process.argv.includes('--group')
    ? process.argv[process.argv.indexOf('--group') + 1]
    : null;

  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const stats = {
    totalFromMe: 0,
    withUserReceipt: 0,
    totalReadCount: 0,
    withReactions: 0,
    totalReactions: 0,
    withReply: 0,
    sampleReceipts: [],
  };

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log('\nOpening QR code in browser — scan with WhatsApp → Linked devices.\n');
        try {
          const dataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Scan with WhatsApp</title>
<style>body{font-family:sans-serif;text-align:center;padding:24px;background:#111;color:#eee;}
h2{margin:0 0 16px;} img{display:block;margin:0 auto 16px;border-radius:8px;}
p{color:#999;}</style></head><body>
<h2>Scan with WhatsApp</h2>
<p>Open WhatsApp → Settings → Linked devices → Link a device</p>
<img src="${dataUrl}" alt="QR code" width="280" height="280">
<p>Keep this window open until linked.</p>
</body></html>`;
          fs.writeFileSync(qrHtmlPath, html, 'utf8');
          const open = (await import('open')).default;
          await open(qrHtmlPath);
        } catch (e) {
          console.error('Could not open QR in browser:', e.message);
          console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
        }
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('Logged out. Exiting.');
          process.exit(0);
        }
        if (statusCode === DisconnectReason.restartRequired) {
          console.log('Reconnecting with saved credentials...');
          connect().catch((e) => { console.error(e); process.exit(1); });
        }
      }
      if (connection === 'open') {
        console.log('Connected. Waiting for history sync (may take a moment)...\n');
        (async () => {
          await delay(15000);
          console.log('--- Engagement data summary (from synced history) ---');
          console.log('Messages from me (in groups):', stats.totalFromMe);
          console.log('Messages with userReceipt:', stats.withUserReceipt);
          console.log('Total read receipts (sum):', stats.totalReadCount);
          console.log('Messages with reactions:', stats.withReactions);
          console.log('Total reactions:', stats.totalReactions);
          console.log('Messages that are replies:', stats.withReply);
          if (stats.sampleReceipts.length) {
            console.log('\nSample userReceipt entries:', JSON.stringify(stats.sampleReceipts, null, 2));
          }
          console.log('\nConclusion: If withUserReceipt > 0, Baileys can provide seen_count for GroupIQ.');
          process.exit(0);
        })();
      }
    });

    sock.ev.on('messaging-history.set', ({ messages: newMessages = [], chats = [] }) => {
      const groupNames = new Map();
      for (const ch of chats || []) {
        if (ch.id && ch.id.endsWith('@g.us') && ch.name) groupNames.set(ch.id, ch.name);
      }
      for (const m of newMessages || []) {
        const key = m.key;
        if (!key || !key.fromMe || !isGroupJid(key.remoteJid)) continue;
        const groupName = groupNames.get(key.remoteJid) || key.remoteJid;
        if (filterGroupName && groupName !== filterGroupName) continue;
        stats.totalFromMe += 1;
        const receipts = m.userReceipt;
        const readCount = getReadCount(receipts);
        if (receipts && receipts.length > 0) {
          stats.withUserReceipt += 1;
          stats.totalReadCount += readCount;
          if (stats.sampleReceipts.length < 3) {
            stats.sampleReceipts.push({
              messageId: key.id,
              group: groupName,
              receiptCount: receipts.length,
              readCount,
              userJids: (receipts || []).map((r) => r.userJid).filter(Boolean),
            });
          }
        }
        const reactionCount = getReactionCount(m.reactions);
        if (reactionCount > 0) {
          stats.withReactions += 1;
          stats.totalReactions += reactionCount;
        }
        if (hasReply(m.message)) stats.withReply += 1;
      }
    });

    return sock;
  }

  connect().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
