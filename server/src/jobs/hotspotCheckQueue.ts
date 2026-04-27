import type { Server } from 'socket.io';
import { prisma } from '../db.js';
import { runHotspotCheck } from './hotspotChecker.js';

type QueueState = {
  running: boolean;
  lastStartedAt?: Date;
  lastFinishedAt?: Date;
  lastError?: string;
};

const HOTSPOT_CHECK_STALE_MS = Math.max(
  10 * 60 * 1000,
  Number.parseInt(process.env.HOTSPOT_CHECK_STALE_MS || '', 10) || 45 * 60 * 1000
);

const state: QueueState = {
  running: false
};

let currentRunToken = 0;
let staleCleanupPromise: Promise<void> | null = null;

function isQueueStale(referenceTime = Date.now()): boolean {
  if (!state.running || !state.lastStartedAt) return false;
  return referenceTime - state.lastStartedAt.getTime() >= HOTSPOT_CHECK_STALE_MS;
}

function scheduleStaleRunRepair(reason: string, cutoff: Date) {
  if (staleCleanupPromise) return;

  staleCleanupPromise = prisma.crawlRun.updateMany({
    where: {
      status: 'running',
      startedAt: { lte: cutoff }
    },
    data: {
      status: 'failed',
      errorMessage: reason,
      completedAt: new Date()
    }
  }).then(() => undefined).catch((error) => {
    console.warn('Failed to repair stale crawl runs:', error instanceof Error ? error.message : error);
  }).finally(() => {
    staleCleanupPromise = null;
  });
}

function releaseStaleQueue(reason: string) {
  if (!state.running || !state.lastStartedAt) return;

  const staleStartedAt = state.lastStartedAt;
  currentRunToken += 1;
  state.running = false;
  state.lastFinishedAt = new Date();
  state.lastError = reason;
  scheduleStaleRunRepair(reason, staleStartedAt);
}

function recoverQueueIfStale() {
  if (!isQueueStale()) return;

  const startedAt = state.lastStartedAt!;
  const staleMinutes = Math.max(1, Math.round((Date.now() - startedAt.getTime()) / 60000));
  const reason = `后台扫描超过 ${staleMinutes} 分钟未结束，系统已自动释放队列`;
  console.warn(`[hotspot-check-queue] ${reason}`);
  releaseStaleQueue(reason);
}

export function getHotspotCheckQueueState(): QueueState {
  recoverQueueIfStale();
  return { ...state };
}

export function startHotspotCheckInBackground(io: Server, triggerType: 'manual' | 'scheduled' = 'manual'): {
  accepted: boolean;
  message: string;
} {
  recoverQueueIfStale();
  if (state.running) {
    return {
      accepted: false,
      message: 'Hotspot check is already running'
    };
  }

  currentRunToken += 1;
  const runToken = currentRunToken;
  state.running = true;
  state.lastStartedAt = new Date();
  state.lastError = undefined;

  void runHotspotCheck(io, triggerType)
    .then(() => {
      if (runToken !== currentRunToken) return;
      state.lastFinishedAt = new Date();
    })
    .catch(error => {
      if (runToken !== currentRunToken) return;
      state.lastError = error instanceof Error ? error.message : String(error);
      console.error('Background hotspot check failed:', error);
    })
    .finally(() => {
      if (runToken !== currentRunToken) return;
      state.running = false;
    });

  return {
    accepted: true,
    message: 'Hotspot check queued'
  };
}
