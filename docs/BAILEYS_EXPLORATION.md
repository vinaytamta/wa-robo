# Baileys Exploration for GroupIQ

This document explores **Baileys** as an alternative to **whatsapp-web.js + Puppeteer** for WhatsApp engagement tracking. Baileys is a WebSocket-based library that does not use a browser.

---

## 1. Why Baileys?

| Aspect | whatsapp-web.js + Puppeteer | Baileys |
|--------|-----------------------------|---------|
| **Browser** | Yes (Chromium via Puppeteer) | **No** – WebSocket protocol only |
| **RAM** | ~300–600 MB | **~50 MB** |
| **Startup** | Slow (browser launch) | **Fast** (< 1 s) |
| **Electron** | Needs Chromium (or system Chrome) | **No Electron dependency** for WA layer |
| **Distribution** | Heavier app | **Lighter** desktop app possible |

---

## 2. GroupIQ Requirements vs Baileys API

### 2.1 Current data we collect (per message)

From `electron/scraper-service.js` we build:

- `message_id`, `group_id`, `group_name`, `sender_id`
- `message_content`, `message_timestamp`, `has_media`, `message_type`, `is_forwarded`
- **Engagement:** `seen_count`, `total_members`, `reactions_count`, `replies_count`, `engagement_rate`

### 2.2 Baileys equivalents

| Requirement | Current (wwebjs) | Baileys | Notes |
|-------------|-------------------|---------|--------|
| **Message list (group, from me, date range)** | `chat.fetchMessages()` then filter | **History sync:** `messaging-history.set` + `fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)` | Need to store messages and implement `getMessage` for Baileys. Filter by `key.remoteJid` (group), `key.fromMe`, `messageTimestamp`. |
| **Seen count (read receipts)** | `msg.getInfo()` → `messageInfo.read.length` | **`IWebMessageInfo.userReceipt`** – array of `IUserReceipt` with `userJid`, `readTimestamp`, `receiptTimestamp`, `playedTimestamp` | **Critical:** Count receipts where `readTimestamp` is set. Must validate: is `userReceipt` populated for **history-synced** messages or only for **live** messages? (PoC will confirm.) |
| **Reactions** | `msg.getReactions()` / `msg.reactions` | **`IWebMessageInfo.reactions`** – `IReaction[]` | Supported. Count or aggregate by reaction type as needed. |
| **Replies (quoted message)** | Messages that quote this message (match `quotedMsg.id`) | **`proto.IMessage.extendedTextMessage.contextInfo.stanzaId`** (quoted message ID) | Scan messages for `contextInfo.stanzaId === thisMessageId` to count replies. |
| **Group participant count** | `chat.participants.length` | Group metadata from **`group-participants.update`** or **chats** in history; participants can be fetched (Baileys has group APIs). | Need to map group JID → participant count for engagement rate. |
| **Auth / session** | `LocalAuth` + Puppeteer (QR in browser) | **`useMultiFileAuthState`** (demo) or custom auth; **QR** via `connection.update` → `qr` | Different auth model; no browser. For production, replace `useMultiFileAuthState` with a proper store. |

### 2.3 Key types (Baileys)

- **IWebMessageInfo**: `key`, `message`, `messageTimestamp`, **`userReceipt`**, **`reactions`**, `participant`, `status`, etc.
- **IUserReceipt**: `userJid`, `readTimestamp`, `receiptTimestamp`, `playedTimestamp`, `pendingDeviceJid`, `deliveredDeviceJid`.
- **IReaction**: reaction content and sender info.

---

## 3. Architecture impact

### 3.1 If we adopt Baileys

- **Electron app** can stay for UI, tray, and local API, but the **WhatsApp layer** becomes a **Node-only** process (no Puppeteer/Chromium for WhatsApp).
- **WhatsApp manager** would:
  - Use `makeWASocket()` with auth state and `getMessage` (from our store).
  - Handle `connection.update` (QR, open, close).
  - Handle `messaging-history.set` and optionally `fetchMessageHistory` for on-demand sync.
  - Expose **same logical API** as today: connect, get groups, run scraper (get messages + engagement), disconnect.
- **Scraper service** would:
  - Get “my” messages from stored history (or from history events) for configured groups.
  - For each message, compute:
    - **seen_count**: `userReceipt.filter(r => r.readTimestamp).length` (or equivalent).
    - **reactions_count**: from `reactions` (e.g. total reaction count).
    - **replies_count**: count messages whose `contextInfo.stanzaId` equals this message id.
  - **engagement_rate**: same formula as now (e.g. unique engaged / (total_members - 1) * 100).

### 3.2 What stays the same

- Local data store (messages, groups, runs).
- Engagement tracking service (periodic refresh of metrics).
- VPS sync and analytics.
- Frontend and Electron shell (optional: could even move to Tauri later if we want).

---

## 4. Risks and unknowns

| Risk | Mitigation |
|------|------------|
| **userReceipt missing in history** | Run PoC: after history sync, check if synced messages have `userReceipt` populated. If only live messages have it, we may need to rely on **live receipt events** and merge into stored messages over time. |
| **Protocol changes** | Baileys is unofficial; WhatsApp can change protocol. Follow Baileys releases and community. |
| **Auth storage** | Do not use `useMultiFileAuthState` in production as-is. Implement a proper auth store (e.g. encrypted, same directory as current session). |
| **History sync limits** | WhatsApp may limit how much history is synced. Use `fetchMessageHistory` for older messages and respect rate limits. |
| **Group name / JID mapping** | History uses JIDs (e.g. `123456789@g.us`). We need a stable mapping to “group name” (from group metadata or first sync). |

---

## 5. PoC objectives

The script in `scripts/baileys-poc.js` (see below) should:

1. Connect with Baileys using `useMultiFileAuthState` (demo auth).
2. On **connection**, wait for history sync or call **fetchMessageHistory** for one group.
3. For messages **from me** in that group:
   - Log whether **userReceipt** is present and how many have **readTimestamp**.
   - Log **reactions** presence and count.
   - Log if message has **contextInfo** (reply).
4. Output a small summary: “For N messages from me, M had userReceipt, K had reactions.”

This validates whether we can get **engagement metrics from Baileys** without a browser. If `userReceipt` is empty on synced history, we document that and consider hybrid (e.g. Baileys for real-time receipt updates only).

---

## 6. References

- [Baileys – Introduction](https://baileys.wiki/docs/intro)
- [Baileys – Presence and Receipts](https://baileys.wiki/docs/socket/presence-receipts/)
- [Baileys – History Sync](https://baileys.wiki/docs/socket/history-sync/)
- [Baileys – Handling Messages](https://baileys.wiki/docs/socket/handling-messages/)
- [IWebMessageInfo](https://baileys.wiki/docs/api/namespaces/proto/interfaces/IWebMessageInfo) (includes `userReceipt`, `reactions`)
- [IUserReceipt](https://baileys.wiki/docs/api/namespaces/proto/interfaces/IUserReceipt)
- [makeWASocket](https://baileys.wiki/docs/api/functions/makeWASocket) (includes `fetchMessageHistory`)

---

## 7. Run the PoC

Install Baileys and run the proof-of-concept (no browser):

```bash
npm install @whiskeysockets/baileys
node scripts/baileys-poc.js
```

Optional: filter by group name so only that group’s messages are counted:

```bash
node scripts/baileys-poc.js --group "Your Group Name"
```

On first run you’ll see a QR code; scan it with WhatsApp → Linked devices. After connection, the script waits for history sync (~15 s), then prints:

- How many “from me” group messages were synced
- How many of those have `userReceipt` (and total read count)
- How many have `reactions`
- A few sample `userReceipt` entries

If **withUserReceipt** is > 0, Baileys can likely replace wwebjs for engagement (seen count). If it’s 0, receipts may only be available for live messages and we’d need a hybrid design.

---

## 8. Next steps

1. **Run PoC** (`scripts/baileys-poc.js`) and record whether `userReceipt` and `reactions` are present on synced messages.
2. If PoC is positive: design **BaileysWhatsAppManager** and **BaileysScraperService** (same interfaces as current ones where possible).
3. If `userReceipt` is only on live messages: design **hybrid** – store messages from history, enrich with receipt/reaction updates from live events.
4. Replace `useMultiFileAuthState` with a production auth store and integrate QR flow into the existing Electron UI.
