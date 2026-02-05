# WhatsApp Message Engagement Tracker

Automated WhatsApp engagement tracking system that monitors "seen by" counts across multiple WhatsApp groups using whatsapp-web.js and stores data in PostgreSQL.

## Features

- ✅ Automates WhatsApp Web using Chrome/Chromium (via whatsapp-web.js)
- ✅ Tracks "seen by" counts for your messages across 20-30 groups
- ✅ Stores engagement data in PostgreSQL (Docker container)
- ✅ Pick and choose which groups to monitor via JSON configuration
- ✅ Incremental tracking (only new messages since last run)
- ✅ Human-like delays (2-8 seconds) to avoid rate limiting
- ✅ Both manual and scheduled execution modes
- ✅ Comprehensive error logging and recovery
- ✅ Session persistence (QR code scan only once)

## Prerequisites

- **Node.js** v18 or higher
- **Docker** and Docker Compose (for PostgreSQL)
- **WhatsApp Account** (already logged in on your phone)
- **Mac or Linux** (tested on macOS, should work on Linux)

## Installation

### 1. Clone and Install Dependencies

```bash
cd wa-robo
npm install
```

### 2. Setup PostgreSQL Database

```bash
# Start PostgreSQL container
docker-compose up -d

# Wait a few seconds for PostgreSQL to start, then initialize schema
npm run setup-db
```

### 3. Configure Environment Variables

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your preferences (optional - defaults work fine)
nano .env
```

**Environment Variables:**
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` - PostgreSQL connection (Docker defaults work)
- `WA_HEADLESS` - Set to `true` for headless Chrome (no browser window)
- `MESSAGES_LOOKBACK_DAYS` - How many days back to check for messages (default: 7)
- `MIN_DELAY_MS`, `MAX_DELAY_MS` - Random delay range between actions (default: 2000-8000ms)
- `ENABLE_SCHEDULED_RUNS` - Set to `true` to enable cron scheduling
- `CRON_SCHEDULE` - Cron expression for scheduled runs (default: `0 9 * * *` = daily at 9 AM)

### 4. Configure Groups to Monitor

Edit `src/config/groups-config.json` to specify which groups to track:

```json
{
  "groups": [
    {
      "name": "Marketing Team",
      "enabled": true,
      "notes": "Main marketing discussion group"
    },
    {
      "name": "Product Updates",
      "enabled": true,
      "notes": "Product announcements"
    },
    {
      "name": "Sales Team",
      "enabled": false,
      "notes": "Temporarily disabled"
    }
  ],
  "config": {
    "autoDiscoverNewGroups": false,
    "matchStrategy": "exact"
  }
}
```

**Match Strategies:**
- `exact` - Case-sensitive exact match of group names
- `fuzzy` - Partial match (e.g., "Marketing" matches "Marketing Team 2024")

## Usage

### First Run - QR Code Authentication

The first time you run the script, you'll need to scan a QR code to authenticate:

```bash
npm start
```

1. A Chrome window will open showing a QR code
2. Open WhatsApp on your phone → Settings → Linked Devices
3. Scan the QR code displayed in Chrome
4. The script will save your session for future runs

### Manual Runs

After authentication, simply run:

```bash
npm start
```

The script will:
1. Load your saved WhatsApp session (no QR code needed)
2. Fetch all your group chats
3. Filter groups based on `groups-config.json`
4. Extract "seen by" counts for your recent messages
5. Save data to PostgreSQL
6. Exit gracefully

### Scheduled Runs

To run the script automatically on a schedule:

1. Enable scheduled runs in `.env`:
   ```env
   ENABLE_SCHEDULED_RUNS=true
   CRON_SCHEDULE=0 9 * * *  # Daily at 9 AM
   ```

2. Start the scheduler:
   ```bash
   npm run scheduled
   ```

The scheduler will run in the background and execute the script at the specified times.

**Cron Schedule Examples:**
- `0 9 * * *` - Daily at 9 AM
- `0 */6 * * *` - Every 6 hours
- `0 9,17 * * *` - Daily at 9 AM and 5 PM
- `0 9 * * 1-5` - Weekdays at 9 AM

### Run Scheduled Task Immediately (for testing)

```bash
npm run scheduled -- --now
```

## Data Analysis

### Connect to PostgreSQL

```bash
# Using Docker exec
docker exec -it wa-robo-db psql -U wa_robo_user -d wa_robo

# Or using psql on host (if installed)
psql -h localhost -p 5432 -U wa_robo_user -d wa_robo
```

### Useful Queries

**Top engaging groups (last 7 days):**
```sql
SELECT
  g.group_name,
  COUNT(*) as message_count,
  AVG(m.seen_count::float / NULLIF(m.total_members, 0) * 100) as avg_engagement_rate
FROM messages m
JOIN groups g ON m.group_id = g.id
WHERE m.message_timestamp > NOW() - INTERVAL '7 days'
GROUP BY g.group_name
ORDER BY avg_engagement_rate DESC;
```

**Engagement trends over time:**
```sql
SELECT
  DATE(checked_at) as date,
  AVG(seen_count) as avg_seen_count
FROM message_snapshots
GROUP BY DATE(checked_at)
ORDER BY date DESC;
```

**Recent script runs:**
```sql
SELECT * FROM script_runs ORDER BY started_at DESC LIMIT 10;
```

**Messages with low engagement:**
```sql
SELECT
  g.group_name,
  m.message_content,
  m.seen_count,
  m.total_members,
  (m.seen_count::float / NULLIF(m.total_members, 0) * 100) as engagement_rate
FROM messages m
JOIN groups g ON m.group_id = g.id
WHERE m.message_timestamp > NOW() - INTERVAL '7 days'
  AND m.seen_count < m.total_members * 0.5
ORDER BY engagement_rate ASC
LIMIT 20;
```

## Project Structure

```
wa-robo/
├── src/
│   ├── config/
│   │   ├── database.js          # PostgreSQL connection pool
│   │   ├── whatsapp.js          # WhatsApp client setup
│   │   └── groups-config.json   # Groups to monitor
│   ├── services/
│   │   └── scraper-service.js   # Message extraction logic
│   ├── models/
│   │   ├── group.js             # Group database operations
│   │   ├── message.js           # Message database operations
│   │   └── script-run.js        # Execution tracking
│   ├── utils/
│   │   ├── logger.js            # Winston logging
│   │   ├── delays.js            # Human-like delays
│   │   └── error-handler.js     # Error handling
│   ├── index.js                 # Main script
│   └── scheduler.js             # Scheduled execution
├── scripts/
│   └── setup-database.js        # Database schema initialization
├── logs/                        # Log files (auto-created)
├── .wwebjs_auth/                # WhatsApp session data (auto-created)
├── docker-compose.yml           # PostgreSQL container
├── .env                         # Environment variables
└── package.json
```

## Database Schema

**Tables:**
- `groups` - WhatsApp group metadata
- `messages` - Tracked message data
- `message_snapshots` - Seen count history (time-series)
- `script_runs` - Execution history
- `errors` - Error logs

## Troubleshooting

### QR Code Not Appearing

1. Make sure Chrome/Chromium is opening (check for browser window)
2. Set `WA_HEADLESS=false` in `.env` to see the browser
3. Check logs in `logs/error.log`

### "Database connection failed"

```bash
# Check if PostgreSQL container is running
docker ps

# If not running, start it
docker-compose up -d

# Check logs
docker logs wa-robo-db
```

### Session Expired / QR Code Required Again

This is normal if:
- You haven't run the script in weeks
- WhatsApp logged you out on the phone
- Session data was deleted

Simply scan the QR code again to re-authenticate.

### "No groups to monitor"

1. Check `src/config/groups-config.json` - make sure groups have `"enabled": true`
2. Ensure group names match exactly (or use `"matchStrategy": "fuzzy"`)
3. Run with `LOG_LEVEL=debug` to see which groups were found:
   ```bash
   LOG_LEVEL=debug npm start
   ```

### WhatsApp Account Banned / Warnings

If you receive warnings from WhatsApp:
1. Stop using the script immediately
2. Increase delays in `.env` (`MIN_DELAY_MS=5000`, `MAX_DELAY_MS=15000`)
3. Reduce number of groups monitored
4. Use an aged WhatsApp account (not newly created)
5. Don't run too frequently (once per day is safer than hourly)

**Important:** This tool is for personal use. Automating WhatsApp violates their Terms of Service. Use at your own risk.

## Rate Limiting & Safety

The script includes several safety features:
- **Random delays** (2-8 seconds) between actions
- **Conservative defaults** to avoid detection
- **Comprehensive error handling** to prevent crashes
- **Graceful shutdown** on Ctrl+C

**Recommendations:**
- Start with 5 groups, gradually increase
- Run once per day maximum (for safety)
- Use an established WhatsApp account (not new)
- Monitor for any warnings from WhatsApp

## Logs

Logs are stored in the `logs/` directory:
- `combined.log` - All logs (info, warn, error)
- `error.log` - Error logs only

View recent logs:
```bash
tail -f logs/combined.log
```

## Updating Groups Configuration

You can update `src/config/groups-config.json` at any time. Changes take effect on the next run.

To enable/disable a group:
```json
{
  "name": "Marketing Team",
  "enabled": false,  // Change to true/false
  "notes": "Updated note"
}
```

## Stopping the Script

### Manual Run
Press `Ctrl+C` to gracefully shutdown.

### Scheduled Run
Press `Ctrl+C` in the scheduler terminal, or:
```bash
pkill -f scheduler.js
```

## Docker Commands

```bash
# Start PostgreSQL
docker-compose up -d

# Stop PostgreSQL (keeps data)
docker-compose down

# Stop and remove all data
docker-compose down -v

# View PostgreSQL logs
docker logs wa-robo-db

# Access PostgreSQL shell
docker exec -it wa-robo-db psql -U wa_robo_user -d wa_robo
```

## Contributing

This is a personal automation tool. Modifications and improvements are welcome!

## License

MIT

## Disclaimer

This tool automates WhatsApp Web, which may violate WhatsApp's Terms of Service. Use at your own risk. The authors are not responsible for any account bans or restrictions.

**Recommended Use Cases:**
- Personal message engagement tracking
- Small-scale analytics for your own groups
- Educational purposes

**Not Recommended:**
- Mass automation
- Commercial use
- Spam or unsolicited messages
- Any activity that violates WhatsApp ToS

## Support

For issues or questions:
1. Check the logs in `logs/error.log`
2. Review this README
3. Check whatsapp-web.js documentation: https://github.com/pedroslopez/whatsapp-web.js

## Acknowledgments

Built with:
- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) - WhatsApp Web automation
- [Puppeteer](https://pptr.dev/) - Chrome automation
- [PostgreSQL](https://www.postgresql.org/) - Database
- [Winston](https://github.com/winstonjs/winston) - Logging
- [node-cron](https://github.com/node-cron/node-cron) - Scheduling
