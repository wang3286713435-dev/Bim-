import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import cron from 'node-cron';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { prisma } from './db.js';
import keywordsRouter from './routes/keywords.js';
import hotspotsRouter from './routes/hotspots.js';
import settingsRouter from './routes/settings.js';
import notificationsRouter from './routes/notifications.js';
import { getHotspotCheckQueueState, startHotspotCheckInBackground } from './jobs/hotspotCheckQueue.js';
import { ensureDefaultKeywords } from './startup/defaultKeywords.js';
import { ensureDefaultSettings } from './startup/defaultSettings.js';
import { getRuntimeConfig } from './services/runtimeConfig.js';
import { getDetailEnrichmentQueueState } from './services/tenderDetailEnrichment.js';
import { isFeishuBitableEnabled, isFeishuWebhookEnabled } from './services/feishu.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, '../../client/dist');
const hasClientBuild = existsSync(path.join(clientDistPath, 'index.html'));
const serverPackagePath = path.resolve(__dirname, '../package.json');

function getAppVersion(): string {
  try {
    const raw = readFileSync(serverPackagePath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const APP_VERSION = getAppVersion();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/keywords', keywordsRouter);
app.use('/api/hotspots', hotspotsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/notifications', notificationsRouter);

// Health check
app.get('/api/health', async (req, res) => {
  const runtimeConfig = await getRuntimeConfig();
  res.json({
    status: 'ok',
    version: APP_VERSION,
    mode: 'bim-tender-monitor',
    frontend: {
      mode: hasClientBuild ? 'served-by-backend' : 'dev-server-required'
    },
    enabledSources: runtimeConfig.tenderSources,
    runtimeConfig: {
      maxAgeDays: runtimeConfig.maxAgeDays,
      sourceResultLimit: runtimeConfig.sourceResultLimit,
      resultsPerKeyword: runtimeConfig.resultsPerKeyword,
      queryVariantsPerKeyword: runtimeConfig.queryVariantsPerKeyword
    },
    integrations: {
      feishuWebhookEnabled: isFeishuWebhookEnabled(),
      feishuBitableEnabled: isFeishuBitableEnabled()
    },
    scheduler: {
      cron: '0 */2 * * *',
      intervalHours: 2,
      description: '每 2 小时自动扫描一次'
    },
    hotspotCheckQueue: getHotspotCheckQueueState(),
    detailEnrichmentQueue: getDetailEnrichmentQueueState(),
    timestamp: new Date().toISOString()
  });
});

// Manual trigger for hotspot check
app.post('/api/check-hotspots', async (req, res) => {
  try {
    const result = startHotspotCheckInBackground(io, 'manual');
    res.status(result.accepted ? 202 : 409).json({
      ...result,
      state: getHotspotCheckQueueState()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to run hotspot check' });
  }
});

if (hasClientBuild) {
  app.use(express.static(clientDistPath));
  app.get(/^(?!\/api|\/socket\.io).*/, (req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('subscribe', (keywords: string[]) => {
    keywords.forEach(kw => socket.join(`keyword:${kw}`));
    console.log(`Socket ${socket.id} subscribed to:`, keywords);
  });

  socket.on('unsubscribe', (keywords: string[]) => {
    keywords.forEach(kw => socket.leave(`keyword:${kw}`));
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Scheduled job: Run hotspot check every 2 hours
cron.schedule('0 */2 * * *', async () => {
  console.log('🔄 Running scheduled hotspot check...');
  try {
    const result = startHotspotCheckInBackground(io, 'scheduled');
    console.log(result.accepted ? '✅ Scheduled hotspot check queued' : `⏭ ${result.message}`);
  } catch (error) {
    console.error('❌ Scheduled hotspot check failed:', error);
  }
});

// Export for use in other modules
export { io };

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, async () => {
  try {
    await ensureDefaultSettings();
    await ensureDefaultKeywords();
  } catch (error) {
    console.error('❌ Failed to initialize default BIM runtime:', error);
  }

  console.log(`
  🔥 BIM Tender Monitor v${APP_VERSION} 启动成功!
  📡 Server running on http://localhost:${PORT}
  🔌 WebSocket ready
  ⏰ Hotspot check scheduled every 2 hours
  🖥 Frontend ${hasClientBuild ? `served from ${clientDistPath}` : 'not built yet'}
  `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});
