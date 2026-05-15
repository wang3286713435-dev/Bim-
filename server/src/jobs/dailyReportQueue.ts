import { prisma } from '../db.js';
import { generateDailyReport } from '../services/dailyReports.js';
import { autoPushDailyReportToFeishu } from '../services/dailyReportFeishu.js';

type QueueState = {
  running: boolean;
  lastStartedAt?: Date;
  lastFinishedAt?: Date;
  lastError?: string;
};

const DAILY_REPORT_STALE_MS = Math.max(
  10 * 60 * 1000,
  Number.parseInt(process.env.DAILY_REPORT_STALE_MS || '', 10) || 45 * 60 * 1000
);

const state: QueueState = {
  running: false
};

let currentRunToken = 0;
let staleCleanupPromise: Promise<void> | null = null;

function isQueueStale(referenceTime = Date.now()): boolean {
  if (!state.running || !state.lastStartedAt) return false;
  return referenceTime - state.lastStartedAt.getTime() >= DAILY_REPORT_STALE_MS;
}

function scheduleStaleRunRepair(reason: string, cutoff: Date) {
  if (staleCleanupPromise) return;
  staleCleanupPromise = prisma.dailyRun.updateMany({
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
    console.warn('Failed to repair stale daily runs:', error instanceof Error ? error.message : error);
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
  const reason = `BIM 日报任务超过 ${staleMinutes} 分钟未结束，系统已自动释放队列`;
  console.warn(`[daily-report-queue] ${reason}`);
  releaseStaleQueue(reason);
}

export function getDailyReportQueueState(): QueueState {
  recoverQueueIfStale();
  return { ...state };
}

export function startDailyReportInBackground(triggerType: 'manual' | 'scheduled' = 'manual'): {
  accepted: boolean;
  message: string;
} {
  recoverQueueIfStale();
  if (state.running) {
    return {
      accepted: false,
      message: 'Daily report generation is already running'
    };
  }

  currentRunToken += 1;
  const runToken = currentRunToken;
  state.running = true;
  state.lastStartedAt = new Date();
  state.lastError = undefined;

  void generateDailyReport(triggerType)
    .then(async (result) => {
      if (runToken !== currentRunToken) return;
      state.lastFinishedAt = new Date();
      const pushResult = await autoPushDailyReportToFeishu(result.reportId, triggerType);
      if (pushResult.status === 'failed') {
        console.warn('Daily report Feishu auto-push failed:', pushResult.log?.errorMessage || 'unknown error');
      }
    })
    .catch((error) => {
      if (runToken !== currentRunToken) return;
      state.lastError = error instanceof Error ? error.message : String(error);
      console.error('Background BIM daily report failed:', error);
    })
    .finally(() => {
      if (runToken !== currentRunToken) return;
      state.running = false;
    });

  return {
    accepted: true,
    message: 'Daily report generation queued'
  };
}
