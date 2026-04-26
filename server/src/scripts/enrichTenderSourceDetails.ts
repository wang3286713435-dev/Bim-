import dotenv from 'dotenv';
import {
  enqueueIncompleteHotspots,
  getDetailEnrichmentQueueState,
} from '../services/tenderDetailEnrichment.js';
import { prisma } from '../db.js';

dotenv.config();

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQueue(timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const state = getDetailEnrichmentQueueState();
    if (!state.running && state.pendingCount === 0) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Detail enrichment queue timeout after ${timeoutMs}ms`);
    }
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const source = getArg('source', 'cebpubservice');
  const limit = Number.parseInt(getArg('limit', '20') || '20', 10);
  const timeoutMs = Number.parseInt(getArg('timeoutMs', '600000') || '600000', 10);

  const before = await prisma.hotspot.findMany({
    where: source ? { source } : undefined,
    select: {
      id: true,
      title: true,
      tenderUnit: true,
      tenderBudgetWan: true,
      tenderDeadline: true,
      tenderBidOpenTime: true,
      tenderServiceScope: true,
      tenderDetailSource: true,
    },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(limit, 100)),
  });

  const queued = await enqueueIncompleteHotspots(limit, { source });
  await waitForQueue(timeoutMs);

  const after = await prisma.hotspot.findMany({
    where: {
      id: {
        in: before.map((item) => item.id),
      },
    },
    select: {
      id: true,
      title: true,
      tenderUnit: true,
      tenderBudgetWan: true,
      tenderDeadline: true,
      tenderBidOpenTime: true,
      tenderServiceScope: true,
      tenderDetailSource: true,
    },
  });
  const afterById = new Map(after.map((item) => [item.id, item]));
  const changed = before
    .map((item) => {
      const next = afterById.get(item.id);
      if (!next) return null;
      const changedFields = Object.keys(next).filter((key) => {
        if (key === 'id' || key === 'title') return false;
        const prevValue = item[key as keyof typeof item];
        const nextValue = next[key as keyof typeof next];
        return String(prevValue ?? '') !== String(nextValue ?? '');
      });
      return changedFields.length ? { id: item.id, title: item.title, changedFields, detailSource: next.tenderDetailSource } : null;
    })
    .filter(Boolean);

  console.log(JSON.stringify({
    source,
    limit,
    queued,
    processed: getDetailEnrichmentQueueState().processedCount,
    changedCount: changed.length,
    changed: changed.slice(0, 10),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
