# Code Optimization & Refactor Opportunities

Granular list of refactor and optimization opportunities across the wa-robo codebase. Ordered by area and impact.

---

## 1. electron/main.js

### 1.1 Duplicate `require('fs')` and inline requires
- **Lines 10, 47, 922, 942, 969, 998, 1183, 1345:** `fs` is required at top (line 47) and again inside `app.isPackaged` (10) and inside route handlers (922, 942, 969, 998). **Refactor:** Use the single top-level `const fs = require('fs')` everywhere; remove redundant `const fs = require('fs')` inside route handlers.
- **Lines 709, 1037:** `const https = require('https')` and `const fetch = (await import('node-fetch')).default` are inside `proxyAnalyticsToVPS` and the catch-all proxy. **Refactor:** Move to top of `startLocalServer()` or module top: `const https = require('https');` and lazy-load or require `node-fetch` once (e.g. at top: `let nodeFetch; async function getFetch() { if (!nodeFetch) nodeFetch = (await import('node-fetch')).default; return nodeFetch; }`) to avoid repeated dynamic import on every request.

### 1.2 Repeated groups-config read/write pattern (DRY)
- **Lines 921–936, 941–963, 968–993, 997–1020:** Four routes (GET, POST add, PATCH, DELETE) each do: `const configPath = path.join(__dirname, '../src/config/groups-config.json');` then `fs.readFileSync` / `JSON.parse`. **Refactor:** Extract helpers at top of server setup, e.g. `function getGroupsConfigPath() { return path.join(__dirname, '../src/config/groups-config.json'); }`, `function readGroupsConfig() { return JSON.parse(fs.readFileSync(getGroupsConfigPath(), 'utf8')); }`, `function writeGroupsConfig(config) { fs.writeFileSync(getGroupsConfigPath(), JSON.stringify(config, null, 2)); }`, and use them in all four routes. Reduces duplication and single place to change if path or format changes.

### 1.3 Message transform duplication (frontend shape)
- **Lines 434–437, 484–488, 503–508, 544–548:** The same “message for frontend” shape appears multiple times: `id: msg.message_id`, `message_member_count: msg.total_members` (or equivalent). **Refactor:** Add a small helper, e.g. `function transformMessageForFrontend(msg) { return { ...msg, id: msg.message_id, message_member_count: msg.total_members }; }` and use it in `/api/messages/recent`, `/api/messages/:id`, `/api/messages/:id/refresh` (and bulk if needed). Keeps frontend contract in one place.

### 1.4 Repeated error response pattern
- **~47 occurrences:** Many routes use `catch (error) { res.status(500).json({ error: error.message }); }` or `res.status(500).json({ success: false, error: error.message });`. **Refactor:** Add an Express error-handling middleware and/or a small helper, e.g. `function sendError(res, status, message, extra) { res.status(status).json({ success: status < 500, error: message, ...extra }); }`, and use it consistently. Optionally use `next(error)` in route handlers and a single `app.use((err, req, res, next) => { ... })` for 500 responses to avoid repeating try/catch in every handler.

### 1.5 Magic numbers
- **Lines 199, 621, 767, 834–835, 877, etc.:** `30000` (heartbeat), `7 * 24 * 60 * 60 * 1000`, `14 * 24 * 60 * 60 * 1000`, `1000` (message limit). **Refactor:** Define constants at top of file or in a small `constants.js`, e.g. `const MS_PER_DAY = 24 * 60 * 60 * 1000;`, `const SSE_HEARTBEAT_MS = 30000;`, `const DEFAULT_ANALYTICS_MESSAGE_LIMIT = 1000;`, and use them. Improves readability and makes tuning one place.

### 1.6 ScraperService instantiation
- **Lines 341, 382, 536, 549:** `new ScraperService(whatsappManager)` is created in multiple route handlers (scraper/run, scraper/test, messages/:id/refresh, tracking-service/start). **Refactor:** Create one shared instance when the server starts (e.g. after `trackingService` init), e.g. `let sharedScraperService = new ScraperService(whatsappManager);`, and reuse it in these routes. Reduces repeated construction and keeps one place to pass `whatsappManager`. Only create a new instance if you intentionally need a fresh config load per request.

### 1.7 VPS proxy duplication (analytics vs catch-all)
- **Lines 704–735 vs 1033–1095:** Both use `https.Agent({ rejectUnauthorized: false })`, similar `fetch` options, and JSON handling. **Refactor:** Extract a single `async function proxyRequestToVPS(req, res, options)` that accepts optional `authHeader` override and handles GET vs non-GET, then call it from `proxyAnalyticsToVPS` (with `getAnalyticsAuthHeader(req)`) and from the catch-all (with `req.headers`). Reduces duplication and keeps SSL/JSON behavior consistent.

### 1.8 Express JSON middleware
- **Line 83:** `expressApp.use('/api', require('express').json());` — `require('express')` is already at top; use `express.json()` for consistency and to avoid re-requiring express.

### 1.9 Load app.getPath('userData') once for VPS token
- **Lines 47–48:** `getVpsTokenPath()` calls `app.getPath('userData')` on every read/write. **Refactor:** Resolve once at module load (after `app` is ready) or inside `startLocalServer` and store in a variable used by `getVpsTokenPath`, or cache inside `getVpsTokenPath` (e.g. `let cached; if (!cached) cached = path.join(app.getPath('userData'), 'vps-token.json'); return cached;`) to avoid repeated system calls.

### 1.10 /api/errors stub
- **Lines 818–825:** Returns empty array with a try/catch that can’t really throw. **Refactor:** Either implement real error listing (e.g. from `localDataStore` or a log) or simplify to `expressApp.get('/api/errors', (req, res) => res.json([]));` and remove the unnecessary try/catch.

---

## 2. electron/local-data-store.js

### 2.1 updateGroupStats O(n) per message
- **Lines 85–98:** For each message in `addMessages`, `updateGroupStats` is called, and inside it `this.messages.filter(m => m.group_name === groupName).length` runs. So for M messages and G groups you do O(M*G) filtering. **Refactor:** Either (a) compute `message_count` once after the loop over messages (e.g. group by `group_name` and then update each group’s `message_count` and `last_scraped`), or (b) maintain a separate `Map(groupName -> count)` and increment in the loop, then write back to `this.groups`. Avoids repeated full array scans.

### 2.2 Magic numbers
- **Lines 114–116, 179–186, 214–224, 241–242:** `50` (runs to keep, default limit), `7`, `30` days, `1000` in engagement-tracking. **Refactor:** Define at top of module, e.g. `const MAX_RUNS_KEPT = 50;`, `const DEFAULT_MESSAGE_LIMIT = 50;`, `const MS_PER_DAY = 24 * 60 * 60 * 1000;`, and use them.

### 2.3 getEngagementTrends date mutation
- **Lines 216–218:** `const startOfDay = new Date(date.setHours(0, 0, 0, 0));` — `setHours` mutates `date`, so the next line `const endOfDay = new Date(date.setHours(23, 59, 59, 999));` uses already-mutated date. **Refactor:** Clone before mutating, e.g. `const d = new Date(date); d.setHours(0,0,0,0); const startOfDay = new Date(d);` and same for endOfDay, so the loop variable isn’t mutated and logic is clearer.

### 2.4 getTopGroups numeric shape
- **Lines 265–266:** `avgEngagement: (g.totalEngagement / g.messages).toFixed(2)` returns a string; callers may expect a number. **Refactor:** Use `parseFloat((g.totalEngagement / g.messages).toFixed(2))` for consistency with other numeric fields and API contracts.

---

## 3. electron/scraper-service.js

### 3.1 Redundant require inside method
- **Lines 84–85:** Inside `getMonitoredGroupsLocal()`, `const fs = require('fs'); const path = require('path');` — both are already at top of file. **Refactor:** Remove these and use the module-level `fs` and `path`.

### 3.2 Duplicate HTTPS agent and node-fetch usage
- **Lines 111–125, 499–516:** Same pattern: `const https = require('https'); const fetch = (await import('node-fetch')).default; const agent = new https.Agent({ rejectUnauthorized: false });` used in `getMonitoredGroups` and `syncMessagesToVPS`. **Refactor:** Add a private method, e.g. `async _fetchVPS(url, options = {})`, that creates the agent once (or caches it), uses a single dynamic import for `node-fetch`, and merges in `agent` and common headers. Call it from both places.

### 3.3 getDelayForMessageAge vs engagement-tracking-service
- **scraper-service 63–76, engagement-tracking-service 313–323:** Both implement “delay by message age” with similar buckets (0–24h, 1–7d, 7–30d, 30d+). Scraper takes `messageTimestamp`, engagement takes `ageInHours`. **Refactor:** Extract a shared utility, e.g. in `electron/utils/delays.js` or `electron/delay-config.js`: `function getDelayMsForMessageAge(ageInHours, configDelays)` returning ms, and have both services use it with their respective configs. Reduces drift and duplicate magic numbers (168, 720, etc.).

### 3.4 Magic numbers (hours)
- **Lines 69–74:** `168` (7 days), `720` (30 days) in hours. **Refactor:** Use named constants, e.g. `const HOURS_7_DAYS = 7 * 24;`, `const HOURS_30_DAYS = 30 * 24;`, for readability.

---

## 4. electron/engagement-tracking-service.js

### 4.1 Duplicate getDelayForMessageAge
- See **3.3** — share with scraper-service via a common delay utility.

### 4.2 Config load pattern
- **Lines 19–56:** Same “read JSON file or return defaults” pattern as scraper-service and message-retry-service. **Refactor:** Extract a generic `loadJsonConfig(filePath, defaultConfig)` in a shared `electron/config-loader.js` and use it in all three services. Reduces boilerplate and ensures consistent error handling.

### 4.3 Magic numbers
- **Lines 36–39, 75, 86, 141, 204:** Interval ms (300000, 900000, …), 120000 (2 min), 2000 (delay). **Refactor:** Define constants or read from config; document units (e.g. `INITIAL_DELAY_MS = 120000`).

---

## 5. electron/message-retry-service.js

### 5.1 Config loading
- Same as **4.2** — use shared `loadJsonConfig` and remove duplicate try/catch/return-defaults.

### 5.2 Duplicate scraper-config path
- **Line 21:** Uses `path.join(__dirname, 'scraper-config.json')` while scraper-service uses the same file. **Refactor:** If both must use the same config, centralize path in one place (e.g. `electron/config-paths.js`) to avoid future path drift.

---

## 6. electron/data-persistence.js

### 6.1 Sync I/O on every save
- **Lines 33–40, 61–68, etc.:** All save/load use `fs.writeFileSync` / `fs.readFileSync`. For large `messages` arrays, this can block the event loop. **Refactor:** Consider async APIs: `fs.promises.writeFile` / `readFile`, and make `saveMessages`, `saveGroups`, `saveRuns`, `saveAll` async (and optionally debounce rapid `saveToFile()` calls from `addMessages` so you don’t write on every single message). Callers (e.g. local-data-store) would then await or fire-and-forget. Improves responsiveness under load.

### 6.2 Repeated load pattern
- **loadMessages, loadGroups, loadRuns:** Same structure: exists check → readFileSync → parse → return, else return default. **Refactor:** Extract `_loadJsonFile(filePath, defaultReturn)` and use it for all three to reduce duplication.

### 6.3 Logging on every save
- **Lines 36, 51, 65, etc.:** `logger.info('Messages saved...')` on every write can be noisy. **Refactor:** Log at debug level, or throttle log messages (e.g. log once per N saves or per second) to avoid log spam during bulk imports.

---

## 7. electron/whatsapp-manager.js

### 7.1 Hardcoded session path fragment
- **Line 54:** `const sessionPath = '.wwebjs_auth/session-wa-robo-session';` is used in lsof grep. If session name or path changes, this can get out of sync. **Refactor:** Derive from the same source as whatsapp client (e.g. `process.env.WWEBJS_AUTH_PATH` or config) or a single constant so there’s one source of truth.

### 7.2 execSync in cleanup
- **Lines 35–99:** Multiple `execSync` calls with timeouts; on Windows this is skipped. **Refactor:** Consider extracting a small `unix-process-cleanup.js` module with functions like `killChromeWwebjs()`, `findPidsLockingPath(path)`, so main.js stays readable and cleanup logic is testable/mockable.

---

## 8. electron/preload.js

### 8.1 Minimal surface
- Preload is small and focused. **Optional:** Add JSDoc for exposed APIs (`setVpsToken`, `startWhatsApp`, etc.) so IDE and future refactors have a clear contract.

---

## 9. src/config/whatsapp.js

### 9.1 Hardcoded remotePath version
- **Line 57:** `remotePath: '.../2.2412.54.html'` is a fixed WhatsApp Web version. **Refactor:** Move to env (e.g. `WA_WEB_VERSION`) or a small config object so you can bump without code change and document upgrade path.

---

## 10. src/utils/logger.js

### 10.1 Duplicate timestamp format
- Console transport uses a custom `printf` with `timestamp`; file transport uses `winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })`. **Refactor:** Use the same format for both or a single `timestamp` formatter so log format is consistent.

### 10.2 Magic number for max size
- **Lines 56, 62:** `10485760` (10MB). **Refactor:** `const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024;` for readability.

---

## 11. src/middleware/auth.js & src/routes/auth.js

### 11.1 Repeated token extraction
- **auth.js 10–11, 50–51; routes/auth.js 108–109:** Same logic: `req.cookies?.session_token || req.headers.authorization?.replace('Bearer ', '')`. **Refactor:** Export a small `function getSessionToken(req)` from middleware (or a shared `auth-utils.js`) and use it in both middleware and logout route. Single place to change if you add another source (e.g. query param for debugging).

### 11.2 console.error in auth
- **auth.js 27, 59; routes/auth.js 38, 95, etc.:** Uses `console.error` instead of the project logger. **Refactor:** Use `const logger = require('../utils/logger');` and `logger.error(...)` for consistency and so logs go to file when configured.

---

## 12. Cross-cutting

### 12.1 Time constants (MS_PER_DAY, etc.)
- Used in main.js, local-data-store, message-retry-service, engagement-tracking-service, src/routes/auth, src/models/user. **Refactor:** Add `src/constants.js` (or `electron/constants.js` for Electron-only) with `MS_PER_DAY`, `DAYS_7`, etc., and require where needed. Reduces magic numbers and keeps units clear.

### 12.2 groups-config path
- **main.js** (4 places), **scraper-service** (getMonitoredGroupsLocal), **src** (env GROUPS_CONFIG_PATH). **Refactor:** Single module, e.g. `getGroupsConfigPath()` that respects `process.env.GROUPS_CONFIG_PATH` and falls back to path relative to project/electron, so both Electron and src can use it.

### 12.3 VPS base URL
- **main.js:** `https://group-iq.com` string in multiple places; **scraper-service:** `this.vpsApiUrl = 'https://group-iq.com/api'`. **Refactor:** `const VPS_BASE_URL = process.env.VPS_BASE_URL || 'https://group-iq.com';` (and `VPS_BASE_URL + '/api'` for API) in one place (e.g. main and scraper both read from env or a shared config) so staging/production can override.

### 12.4 SSL: rejectUnauthorized: false
- Used in main.js (proxy, analytics) and scraper-service for all VPS requests. **Refactor:** Gate on env (e.g. `NODE_ENV !== 'production'` or `ALLOW_INSECURE_SSL=true`) and log a warning when disabled, so production defaults to secure.

---

## 13. Minor / style

- **main.js:** Many route handlers could be moved to a separate `electron/routes/` (e.g. `whatsapp.js`, `analytics.js`, `messages.js`, `config.js`) and mounted with `expressApp.use('/api/whatsapp', whatsappRoutes)` to keep main.js shorter and routes testable.
- **JSDoc:** Add brief JSDoc to public/service functions (e.g. `localDataStore.addMessages`, `proxyAnalyticsToVPS`) for parameters and return values.
- **Engagement tracking:** `getDelayForMessageAge` in engagement-tracking-service takes `ageInHours` (number) while scraper’s takes `messageTimestamp` (date); naming/documentation could make this distinction obvious to avoid misuse.

---

## Priority summary

| Priority | Area | Impact |
|----------|------|--------|
| High | main.js: groups-config DRY, message transform helper, shared ScraperService | Less duplication, fewer bugs |
| High | local-data-store: updateGroupStats O(n) → O(1) per group | Performance with many messages |
| Medium | main.js: error handler middleware, constants (MS_PER_DAY, etc.) | Consistency, maintainability |
| Medium | Shared VPS fetch + config loader (scraper, engagement, retry) | DRY, consistent SSL/config |
| Medium | data-persistence: async save + debounce | Responsiveness under load |
| Low | Time constants, VPS URL/env, SSL flag | Configurability, security |
| Low | Logger in src auth, JSDoc, route splitting | Consistency, readability |

Implementing the high-priority items first will give the biggest maintainability and performance gains with minimal risk.
