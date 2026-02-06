const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const http = require('http');

// When packaged, logs must go to userData (not inside app.asar) to avoid ENOTDIR on Windows
if (app.isPackaged && !process.env.LOGS_DIR) {
  process.env.LOGS_DIR = path.join(app.getPath('userData'), 'logs');
}

const whatsappManager = require('./whatsapp-manager');
const ScraperService = require('./scraper-service');
const EngagementTrackingService = require('./engagement-tracking-service');
const localDataStore = require('./local-data-store');

// Environment detection
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow = null;
let tray = null;
let localServer = null;
let localPort = 3100;
let whatsappProcess = null;
let sseClients = [];
let trackingService = null;

// Create local Express server to serve the dashboard
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const expressApp = express();

    // Serve static files from public directory
    expressApp.use(express.static(path.join(__dirname, '../public')));

    // API proxy to VPS
    expressApp.use('/api', require('express').json());

    // Mark requests as coming from Electron
    expressApp.use((req, res, next) => {
      req.headers['x-client-type'] = 'electron';
      next();
    });

    // Local WhatsApp endpoints (not proxied to VPS)
    expressApp.get('/api/whatsapp/status', (req, res) => {
      try {
        const status = whatsappManager.getStatus();
        res.json({
          success: true,
          ...status
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    expressApp.get('/api/whatsapp/qr', (req, res) => {
      try {
        const qr = whatsappManager.getQRCode();
        const status = whatsappManager.getStatus();

        if (!qr) {
          return res.json({
            success: false,
            message: 'No QR code available',
            status: status.status
          });
        }

        res.json({
          success: true,
          qr,
          status: status.status
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    expressApp.get('/api/whatsapp/events', (req, res) => {
      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Send initial status
      const initialStatus = whatsappManager.getStatus();
      res.write(`data: ${JSON.stringify(initialStatus)}\n\n`);

      // Add client to list
      sseClients.push(res);

      // Setup event listeners
      const onQR = (data) => {
        if (!res.writableEnded) {
          res.write(`event: qr\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const onReady = (data) => {
        if (!res.writableEnded) {
          res.write(`event: ready\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const onDisconnected = (data) => {
        if (!res.writableEnded) {
          res.write(`event: disconnected\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const onError = (data) => {
        if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const onStatus = (data) => {
        if (!res.writableEnded) {
          res.write(`event: status\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      // Register listeners
      whatsappManager.on('qr', onQR);
      whatsappManager.on('ready', onReady);
      whatsappManager.on('disconnected', onDisconnected);
      whatsappManager.on('error', onError);
      whatsappManager.on('status', onStatus);

      // Keep connection alive with heartbeat
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(':heartbeat\n\n');
        }
      }, 30000);

      // Clean up on client disconnect
      req.on('close', () => {
        clearInterval(heartbeat);
        whatsappManager.off('qr', onQR);
        whatsappManager.off('ready', onReady);
        whatsappManager.off('disconnected', onDisconnected);
        whatsappManager.off('error', onError);
        whatsappManager.off('status', onStatus);

        // Remove from clients list
        const index = sseClients.indexOf(res);
        if (index > -1) {
          sseClients.splice(index, 1);
        }
      });
    });

    expressApp.post('/api/whatsapp/connect', async (req, res) => {
      try {
        if (whatsappManager.hasClient()) {
          return res.json({
            success: false,
            message: 'WhatsApp client already exists',
            status: whatsappManager.getStatus()
          });
        }

        const result = await whatsappManager.initialize();
        const status = whatsappManager.getStatus();

        res.json({
          success: true,
          message: 'WhatsApp client initializing. Please scan QR code.',
          status: status.status
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    expressApp.post('/api/whatsapp/disconnect', async (req, res) => {
      try {
        if (!whatsappManager.hasClient()) {
          return res.json({
            success: false,
            message: 'No active WhatsApp client'
          });
        }

        await whatsappManager.disconnect();

        res.json({
          success: true,
          message: 'WhatsApp client disconnected'
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    expressApp.post('/api/whatsapp/logout', async (req, res) => {
      try {
        if (!whatsappManager.hasClient()) {
          return res.json({
            success: false,
            message: 'No active WhatsApp client'
          });
        }

        await whatsappManager.logout();

        res.json({
          success: true,
          message: 'WhatsApp logged out successfully'
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    expressApp.get('/api/whatsapp/groups', async (req, res) => {
      try {
        const status = whatsappManager.getStatus();

        if (status.status !== 'ready') {
          return res.status(400).json({
            success: false,
            message: 'WhatsApp not connected',
            status: status.status
          });
        }

        const groups = await whatsappManager.getChats();

        res.json({
          success: true,
          groups,
          count: groups.length
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    expressApp.post('/api/scraper/run', async (req, res) => {
      try {
        const status = whatsappManager.getStatus();

        if (status.status !== 'ready') {
          return res.status(400).json({
            success: false,
            message: 'WhatsApp not connected',
            status: status.status
          });
        }

        // Get auth token from request
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
          return res.status(401).json({
            success: false,
            message: 'Authentication required'
          });
        }

        const lookbackDays = parseInt(req.body?.lookbackDays || 7);
        const syncToVPS = req.body?.syncToVPS !== false; // Default true for compatibility

        // Create scraper service and run
        const scraperService = new ScraperService(whatsappManager);
        const result = await scraperService.runScraping(token, lookbackDays, syncToVPS);

        res.json(result);
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Engagement tracking service status endpoint
    expressApp.get('/api/tracking-service/status', (req, res) => {
      try {
        if (!trackingService) {
          return res.json({
            isRunning: false,
            message: 'Engagement tracking service not initialized'
          });
        }

        const status = trackingService.getStatus();
        res.json(status);
      } catch (error) {
        res.status(500).json({
          error: error.message
        });
      }
    });

    // Start/stop engagement tracking service endpoints
    expressApp.post('/api/tracking-service/start', (req, res) => {
      try {
        if (!trackingService) {
          const scraperService = new ScraperService(whatsappManager);
          trackingService = new EngagementTrackingService(scraperService, localDataStore);
        }

        trackingService.start();
        res.json({
          success: true,
          status: trackingService.getStatus()
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    expressApp.post('/api/tracking-service/stop', (req, res) => {
      try {
        if (!trackingService) {
          return res.json({
            success: false,
            message: 'Engagement tracking service not initialized'
          });
        }

        trackingService.stop();
        res.json({
          success: true,
          status: trackingService.getStatus()
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Legacy endpoint for backwards compatibility
    expressApp.get('/api/retry-service/status', (req, res) => {
      res.redirect('/api/tracking-service/status');
    });

    expressApp.post('/api/scraper/test', async (req, res) => {
      try {
        const groupName = req.body?.groupName;
        if (!groupName) {
          return res.status(400).json({
            success: false,
            message: 'groupName is required'
          });
        }

        const lookbackDays = parseInt(req.body?.lookbackDays || 30);

        // Get messages from LOCAL DATABASE (instant, no API calls!)
        const allMessages = localDataStore.getRecentMessages(1000);
        const groupMessages = allMessages.filter(m => m.group_name === groupName);

        // Filter by lookback days
        const cutoffDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
        const filteredMessages = groupMessages.filter(m =>
          new Date(m.message_timestamp) >= cutoffDate
        );

        console.log('Test scrape from local DB:', {
          group: groupName,
          lookbackDays,
          messagesFound: filteredMessages.length
        });

        if (filteredMessages.length === 0) {
          return res.json({
            success: false,
            message: `No messages found for "${groupName}" in the last ${lookbackDays} days.\n\nTip: Click "Run Scraper" first to fetch messages, then try again.`
          });
        }

        res.json({
          success: true,
          group: {
            name: groupName,
            participants: filteredMessages[0]?.total_members || 0
          },
          stats: {
            yourMessages: filteredMessages.length,
            lookbackDays
          },
          allMessages: filteredMessages
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Local API endpoints (served from local data store)
    expressApp.get('/api/messages/recent', (req, res) => {
      try {
        const limit = parseInt(req.query.limit || 50);
        const messages = localDataStore.getRecentMessages(limit);

        // Transform to match frontend expectations
        const transformed = messages.map(msg => ({
          ...msg,
          id: msg.message_id, // Add id field
          message_member_count: msg.total_members // Add message_member_count field
        }));

        res.json(transformed);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/messages/:id', (req, res) => {
      try {
        const message = localDataStore.getMessageById(req.params.id);
        if (!message) {
          return res.status(404).json({ error: 'Message not found' });
        }

        // Transform to match frontend expectations
        const transformed = {
          ...message,
          id: message.message_id,
          message_member_count: message.total_members
        };

        res.json(transformed);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.post('/api/messages/:id/refresh', async (req, res) => {
      try {
        const messageId = req.params.id;
        const message = localDataStore.getMessageById(messageId);

        if (!message) {
          return res.status(404).json({ error: 'Message not found' });
        }

        // Check if WhatsApp is connected
        const status = whatsappManager.getStatus();
        if (status.status !== 'ready') {
          return res.status(400).json({
            success: false,
            message: 'WhatsApp not connected',
            status: status.status
          });
        }

        // Create scraper service and refresh this specific message
        const scraperService = new ScraperService(whatsappManager);
        const result = await scraperService.refreshMessageStats(messageId, message.group_name);

        if (result.success) {
          // Get the updated message
          const updatedMessage = localDataStore.getMessageById(messageId);
          res.json({
            success: true,
            message: 'Stats refreshed successfully',
            data: {
              ...updatedMessage,
              id: updatedMessage.message_id,
              message_member_count: updatedMessage.total_members
            }
          });
        } else {
          res.status(404).json(result);
        }
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // Update message tracking status
    expressApp.put('/api/messages/:id/tracking', (req, res) => {
      try {
        const messageId = req.params.id;
        const { is_tracked } = req.body;

        if (typeof is_tracked !== 'boolean') {
          return res.status(400).json({ error: 'is_tracked must be a boolean' });
        }

        const success = localDataStore.updateMessageTracking(messageId, is_tracked);

        if (success) {
          res.json({ success: true, message: 'Tracking status updated' });
        } else {
          res.status(404).json({ error: 'Message not found' });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Bulk update message tracking status
    expressApp.post('/api/messages/bulk-update-tracking', (req, res) => {
      try {
        const { message_ids, is_tracked } = req.body;

        if (!Array.isArray(message_ids)) {
          return res.status(400).json({ error: 'message_ids must be an array' });
        }

        if (typeof is_tracked !== 'boolean') {
          return res.status(400).json({ error: 'is_tracked must be a boolean' });
        }

        let successCount = 0;
        let failCount = 0;

        message_ids.forEach(messageId => {
          const success = localDataStore.updateMessageTracking(messageId, is_tracked);
          if (success) successCount++;
          else failCount++;
        });

        res.json({
          success: true,
          message: `Updated ${successCount} messages, ${failCount} failed`,
          updated: successCount,
          failed: failCount
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/dashboard/stats', (req, res) => {
      try {
        const stats = localDataStore.getDashboardStats();
        const runs = localDataStore.getRuns(20);

        // Count runs in last 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const runsLast7Days = runs.filter(r =>
          new Date(r.timestamp) >= sevenDaysAgo
        ).length;

        // Transform to match frontend expectations
        res.json({
          active_groups: stats.totalGroups,
          messages_last_7_days: stats.messagesLast7Days,
          runs_last_7_days: runsLast7Days,
          avg_engagement_rate: stats.averageEngagement
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/dashboard/trends', (req, res) => {
      try {
        const days = parseInt(req.query.days || 7);
        const trends = localDataStore.getEngagementTrends(days);

        // Transform to match frontend expectations
        const transformed = trends.map(t => ({
          date: t.date,
          message_count: t.messages,
          avg_engagement_rate: t.avgEngagement
        }));

        res.json(transformed);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/groups', (req, res) => {
      try {
        const groups = localDataStore.getGroups();
        const messages = localDataStore.getRecentMessages(1000);

        // Transform groups to match frontend expectations
        const transformed = groups.map((group, index) => {
          // Get messages for this group to calculate average engagement
          const groupMessages = messages.filter(m => m.group_name === group.name);
          const avgEngagement = groupMessages.length > 0
            ? groupMessages.reduce((sum, m) => sum + m.engagement_rate, 0) / groupMessages.length
            : 0;

          return {
            id: index + 1,
            group_name: group.name,
            total_members: group.total_members || 0,
            message_count: group.message_count || 0,
            avg_engagement_rate: avgEngagement,
            is_active: true, // All groups are active by default
            last_scraped: group.last_scraped
          };
        });

        res.json(transformed);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/groups/:id/messages', (req, res) => {
      try {
        const groupName = decodeURIComponent(req.params.id);
        const limit = parseInt(req.query.limit || 50);
        const offset = parseInt(req.query.offset || 0);
        const messages = localDataStore.getGroupMessages(groupName, limit, offset);
        res.json(messages);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/analytics/top-groups', (req, res) => {
      try {
        const days = parseInt(req.query.days || 7);
        const topGroups = localDataStore.getTopGroups(days);

        // Transform to match frontend expectations
        const transformed = topGroups.map(g => ({
          group_id: g.name, // Use name as ID for now
          group_name: g.name,
          current_group_size: g.totalMembers,
          message_count: g.messages,
          avg_engagement_rate: g.avgEngagement
        }));

        res.json(transformed);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/analytics/engagement-trends', (req, res) => {
      try {
        const days = parseInt(req.query.days || 7);
        const messages = localDataStore.getRecentMessages(1000);
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // Group messages by date and group name
        const trendsByDateAndGroup = [];
        const groups = new Set();

        messages.forEach(msg => {
          const msgDate = new Date(msg.message_timestamp);
          if (msgDate >= cutoffDate) {
            const dateStr = msgDate.toISOString().split('T')[0];
            groups.add(msg.group_name);

            trendsByDateAndGroup.push({
              date: dateStr,
              group_name: msg.group_name,
              avg_engagement: msg.engagement_rate,
              message_count: 1
            });
          }
        });

        // Sort by date ascending (oldest to newest)
        trendsByDateAndGroup.sort((a, b) => new Date(a.date) - new Date(b.date));

        res.json(trendsByDateAndGroup);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/runs', (req, res) => {
      try {
        const limit = parseInt(req.query.limit || 20);
        const runs = localDataStore.getRuns(limit);

        // Transform to match frontend expectations
        const transformed = runs.map(run => ({
          id: run.id,
          started_at: run.timestamp,
          completed_at: run.timestamp, // Same as started since runs complete quickly
          groups_checked: run.groups_processed,
          messages_processed: run.messages_found,
          errors_count: 0,
          status: run.status
        }));

        res.json(transformed);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/errors', (req, res) => {
      try {
        // Return empty array for now - errors can be tracked later if needed
        res.json([]);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/analytics/weekly-comparison', (req, res) => {
      try {
        const now = new Date();
        const thisWeekStart = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const lastWeekStart = new Date(now - 14 * 24 * 60 * 60 * 1000);

        const messages = localDataStore.getRecentMessages(1000);

        const thisWeekMessages = messages.filter(m =>
          new Date(m.message_timestamp) >= thisWeekStart
        );
        const lastWeekMessages = messages.filter(m => {
          const msgDate = new Date(m.message_timestamp);
          return msgDate >= lastWeekStart && msgDate < thisWeekStart;
        });

        const thisWeekAvg = thisWeekMessages.length > 0
          ? thisWeekMessages.reduce((sum, m) => sum + m.engagement_rate, 0) / thisWeekMessages.length
          : 0;
        const lastWeekAvg = lastWeekMessages.length > 0
          ? lastWeekMessages.reduce((sum, m) => sum + m.engagement_rate, 0) / lastWeekMessages.length
          : 0;

        const thisWeekGroups = new Set(thisWeekMessages.map(m => m.group_name)).size;
        const lastWeekGroups = new Set(lastWeekMessages.map(m => m.group_name)).size;

        res.json({
          messages_this_week: thisWeekMessages.length,
          messages_last_week: lastWeekMessages.length,
          engagement_this_week: parseFloat(thisWeekAvg.toFixed(2)),
          engagement_last_week: parseFloat(lastWeekAvg.toFixed(2)),
          active_groups_this_week: thisWeekGroups,
          active_groups_last_week: lastWeekGroups
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/analytics/engagement-by-day', (req, res) => {
      try {
        const days = parseInt(req.query.days || 7);
        const messages = localDataStore.getRecentMessages(1000);
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // Group messages by day of week
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayStats = {};

        messages.forEach(msg => {
          const msgDate = new Date(msg.message_timestamp);
          if (msgDate >= cutoffDate) {
            const dayNum = msgDate.getDay();
            const dayName = dayNames[dayNum];

            if (!dayStats[dayNum]) {
              dayStats[dayNum] = {
                day_name: dayName,
                day_number: dayNum,
                message_count: 0,
                total_engagement: 0
              };
            }

            dayStats[dayNum].message_count++;
            dayStats[dayNum].total_engagement += msg.engagement_rate;
          }
        });

        // Calculate averages and format response
        const result = Object.values(dayStats).map((day) => ({
          day_name: day.day_name,
          day_number: day.day_number,
          message_count: day.message_count,
          avg_engagement: parseFloat((day.total_engagement / day.message_count).toFixed(2))
        }));

        // Sort by day number
        result.sort((a, b) => a.day_number - b.day_number);

        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.get('/api/config/groups', (req, res) => {
      try {
        const fs = require('fs');
        const configPath = path.join(__dirname, '../src/config/groups-config.json');
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);

        // Return in VPS API format
        res.json({
          groups: config.groups || [],
          config: {
            autoDiscover: config.config?.autoDiscoverNewGroups || false,
            defaultMatchStrategy: config.config?.matchStrategy || 'exact'
          }
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.post('/api/config/groups/add', (req, res) => {
      try {
        const fs = require('fs');
        const configPath = path.join(__dirname, '../src/config/groups-config.json');
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);

        const { name, enabled, notes } = req.body;

        // Check if group already exists
        const existingGroup = config.groups.find(g => g.name === name);
        if (existingGroup) {
          return res.status(400).json({ error: 'Group already exists' });
        }

        // Add new group
        config.groups.push({ name, enabled, notes: notes || '' });

        // Save config
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        res.json({ success: true, message: 'Group added successfully' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.patch('/api/config/groups/:name', (req, res) => {
      try {
        const fs = require('fs');
        const configPath = path.join(__dirname, '../src/config/groups-config.json');
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);

        const groupName = decodeURIComponent(req.params.name);
        const updates = req.body;

        // Find and update group
        const group = config.groups.find(g => g.name === groupName);
        if (!group) {
          return res.status(404).json({ error: 'Group not found' });
        }

        // Apply updates
        if (updates.enabled !== undefined) group.enabled = updates.enabled;
        if (updates.notes !== undefined) group.notes = updates.notes;

        // Save config
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        res.json({ success: true, message: 'Group updated successfully' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    expressApp.delete('/api/config/groups/:name', (req, res) => {
      try {
        const fs = require('fs');
        const configPath = path.join(__dirname, '../src/config/groups-config.json');
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);

        const groupName = decodeURIComponent(req.params.name);

        // Filter out the group
        const initialLength = config.groups.length;
        config.groups = config.groups.filter(g => g.name !== groupName);

        if (config.groups.length === initialLength) {
          return res.status(404).json({ error: 'Group not found' });
        }

        // Save config
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        res.json({ success: true, message: 'Group removed successfully' });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Proxy API calls to VPS
    expressApp.all('/api/*', async (req, res) => {
      const apiUrl = `https://group-iq.com${req.path}`;

      try {
        const https = require('https');
        const fetch = (await import('node-fetch')).default;

        // Create HTTPS agent that ignores SSL errors (for development)
        const agent = new https.Agent({
          rejectUnauthorized: false
        });

        const response = await fetch(apiUrl, {
          method: req.method,
          headers: {
            'Content-Type': 'application/json',
            'x-client-type': 'electron',
            'Cookie': req.headers.cookie || '',
            ...req.headers
          },
          body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
          agent: agent
        });

        // Check if response is JSON
        const contentType = response.headers.get('content-type');
        let data;

        if (contentType && contentType.includes('application/json')) {
          try {
            data = await response.json();
          } catch (jsonError) {
            console.error('Failed to parse JSON response:', jsonError);
            data = { error: 'Invalid JSON response from server' };
          }
        } else {
          // Not JSON - probably an error page
          const text = await response.text();
          console.error('Non-JSON response from VPS:', text.substring(0, 200));
          data = {
            error: 'Server returned non-JSON response',
            status: response.status,
            statusText: response.statusText
          };
        }

        // Forward cookies
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) {
          res.setHeader('Set-Cookie', setCookie);
        }

        res.status(response.status).json(data);
      } catch (error) {
        console.error('API proxy error:', error);
        res.status(500).json({ error: 'Failed to connect to server', details: error.message });
      }
    });

    localServer = http.createServer(expressApp);

    // Initialize and start engagement tracking service
    try {
      const scraperService = new ScraperService(whatsappManager);
      trackingService = new EngagementTrackingService(scraperService, localDataStore);
      trackingService.start();
      console.log('Engagement tracking service initialized and started');
      console.log('→ Tracking messages for 30 days with progressive delays');
      console.log('→ Old messages (7-30 days) get 15s delay for accurate data capture');
    } catch (error) {
      console.error('Failed to start engagement tracking service:', error.message);
    }

    localServer.listen(localPort, () => {
      console.log(`Local server started at http://localhost:${localPort}`);
      resolve();
    });

    localServer.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        localPort++;
        localServer.listen(localPort);
      } else {
        reject(error);
      }
    });
  });
}

// Create main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: 'GroupIQ',
    backgroundColor: '#667eea',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
    show: false
  });

  // Load the local dashboard
  mainWindow.loadURL(`http://localhost:${localPort}`);

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle window close
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();

      if (Notification.isSupported()) {
        new Notification({
          title: 'GroupIQ',
          body: 'App minimized to system tray'
        }).show();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open DevTools in development
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
}

// Create system tray
function createTray() {
  const iconPath = path.join(__dirname, '../build/tray-icon.png');

  if (require('fs').existsSync(iconPath)) {
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Dashboard',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
          } else {
            createWindow();
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('GroupIQ');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
      }
    });
  }
}

// Start WhatsApp scraper process
function startWhatsAppScraper(userData) {
  if (whatsappProcess) {
    return { success: false, error: 'WhatsApp is already running' };
  }

  const scraperPath = isDev
    ? path.join(__dirname, '../src/scraper-client.js')
    : path.join(process.resourcesPath, 'app.asar.unpacked/src/scraper-client.js');

  whatsappProcess = spawn('node', [scraperPath], {
    env: {
      ...process.env,
      USER_DATA: JSON.stringify(userData),
      ELECTRON_APP: 'true'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  whatsappProcess.stdout.on('data', (data) => {
    console.log(`WhatsApp: ${data}`);
    if (mainWindow) {
      mainWindow.webContents.send('whatsapp-log', data.toString());
    }
  });

  whatsappProcess.stderr.on('data', (data) => {
    console.error(`WhatsApp Error: ${data}`);
    if (mainWindow) {
      mainWindow.webContents.send('whatsapp-error', data.toString());
    }
  });

  whatsappProcess.on('close', (code) => {
    console.log(`WhatsApp process closed with code ${code}`);
    whatsappProcess = null;
    if (mainWindow) {
      mainWindow.webContents.send('whatsapp-stopped', code);
    }
  });

  return { success: true };
}

// Stop WhatsApp scraper
function stopWhatsAppScraper() {
  if (whatsappProcess) {
    whatsappProcess.kill();
    whatsappProcess = null;
    return { success: true };
  }
  return { success: false, error: 'WhatsApp is not running' };
}

// App ready
app.whenReady().then(async () => {
  try {
    // Start local server
    await startLocalServer();

    // Create window and tray
    createWindow();
    createTray();
  } catch (error) {
    console.error('Failed to start app:', error);
    dialog.showErrorBox('Startup Error', 'Failed to start the application. Please try again.');
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup on quit
app.on('before-quit', () => {
  app.isQuitting = true;

  if (whatsappProcess) {
    whatsappProcess.kill();
  }

  if (localServer) {
    localServer.close();
  }
});

// IPC Handlers
ipcMain.handle('start-whatsapp', async (event, userData) => {
  return startWhatsAppScraper(userData);
});

ipcMain.handle('stop-whatsapp', async () => {
  return stopWhatsAppScraper();
});

ipcMain.handle('get-whatsapp-status', async () => {
  return {
    running: whatsappProcess !== null
  };
});

ipcMain.handle('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection:', reason);
});
