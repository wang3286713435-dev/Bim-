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
import authRouter from './routes/auth.js';
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
import { getProxyHealthRefreshIntervalMs, hasEnabledProxyPool, refreshProxyPoolHealth } from './services/proxyPool.js';
import { getSessionFromRequest, requireAuth } from './services/auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, '../../client/dist');
const hasClientBuild = existsSync(path.join(clientDistPath, 'index.html'));
const serverPackagePath = path.resolve(__dirname, '../package.json');
const HOTSPOT_SCHEDULE_CRON = process.env.HOTSPOT_CHECK_CRON || '0 0 * * *';
const HOTSPOT_SCHEDULE_INTERVAL_HOURS = Math.max(
  1,
  Number.parseInt(process.env.HOTSPOT_CHECK_INTERVAL_HOURS || '24', 10) || 24
);
const HOTSPOT_SCHEDULE_DESCRIPTION = HOTSPOT_SCHEDULE_INTERVAL_HOURS === 24
  ? '每天自动扫描一次'
  : `每 ${HOTSPOT_SCHEDULE_INTERVAL_HOURS} 小时自动扫描一次`;
const FORCE_HTTPS = process.env.FORCE_HTTPS === 'true';

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
app.set('trust proxy', true);
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use((req, res, next) => {
  if (!FORCE_HTTPS) {
    return next();
  }

  const forwardedProto = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const cfVisitor = req.header('cf-visitor');
  const isSecureRequest = req.secure
    || forwardedProto === 'https'
    || Boolean(cfVisitor && /"scheme":"https"/i.test(cfVisitor));
  if (isSecureRequest) {
    return next();
  }

  const host = req.header('host');
  if (!host) {
    return next();
  }

  return res.redirect(301, `https://${host}${req.originalUrl}`);
});
app.use(express.json());

// Routes
app.use('/api/auth', authRouter);
app.use('/api', requireAuth);
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
      queryVariantsPerKeyword: runtimeConfig.queryVariantsPerKeyword,
      keywordCooldownZeroSaveThreshold: runtimeConfig.keywordCooldownZeroSaveThreshold,
      keywordCooldownHours: runtimeConfig.keywordCooldownHours,
      keywordCooldownLookbackDays: runtimeConfig.keywordCooldownLookbackDays
    },
    integrations: {
      feishuWebhookEnabled: isFeishuWebhookEnabled(),
      feishuBitableEnabled: isFeishuBitableEnabled()
    },
    scheduler: {
      cron: HOTSPOT_SCHEDULE_CRON,
      intervalHours: HOTSPOT_SCHEDULE_INTERVAL_HOURS,
      description: HOTSPOT_SCHEDULE_DESCRIPTION
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
io.use((socket, next) => {
  const session = getSessionFromRequest(socket.request as typeof socket.request & { headers: { cookie?: string } });
  if (!session) {
    next(new Error('AUTH_REQUIRED'));
    return;
  }

  socket.data.authUser = session.username;
  next();
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id, socket.data.authUser ? `(${socket.data.authUser})` : '');

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

// Scheduled job: Run hotspot check daily by default.
cron.schedule(HOTSPOT_SCHEDULE_CRON, async () => {
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
    if (hasEnabledProxyPool()) {
      await refreshProxyPoolHealth(true).catch((error) => {
        console.warn('Failed to initialize proxy pool health:', error instanceof Error ? error.message : error);
      });
      const proxyHealthTimer = setInterval(() => {
        void refreshProxyPoolHealth().catch((error) => {
          console.warn('Failed to refresh proxy pool health:', error instanceof Error ? error.message : error);
        });
      }, getProxyHealthRefreshIntervalMs());
      proxyHealthTimer.unref();
    }
  } catch (error) {
    console.error('❌ Failed to initialize default BIM runtime:', error);
  }

  console.log(`
  🔥 BIM Tender Monitor v${APP_VERSION} 启动成功!
  📡 Server running on http://localhost:${PORT}
  🔌 WebSocket ready
  ⏰ Hotspot check schedule: ${HOTSPOT_SCHEDULE_DESCRIPTION}
  🖥 Frontend ${hasClientBuild ? `served from ${clientDistPath}` : 'not built yet'}
  `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});
