import { prisma } from '../db.js';

export async function createCrawlRun(input: {
  triggerType: 'manual' | 'scheduled';
  keywordId?: string;
  keywordText?: string;
  searchQueries?: string[];
}) {
  return prisma.crawlRun.create({
    data: {
      triggerType: input.triggerType,
      keywordId: input.keywordId,
      keywordText: input.keywordText,
      searchQueries: input.searchQueries ? JSON.stringify(input.searchQueries) : null
    }
  });
}

export async function updateCrawlRun(runId: string, patch: {
  status?: 'running' | 'completed' | 'failed';
  totalRaw?: number;
  totalUnique?: number;
  totalFresh?: number;
  totalSaved?: number;
  totalFiltered?: number;
  errorMessage?: string | null;
  completed?: boolean;
}) {
  return prisma.crawlRun.update({
    where: { id: runId },
    data: {
      status: patch.status,
      totalRaw: patch.totalRaw,
      totalUnique: patch.totalUnique,
      totalFresh: patch.totalFresh,
      totalSaved: patch.totalSaved,
      totalFiltered: patch.totalFiltered,
      errorMessage: patch.errorMessage,
      completedAt: patch.completed ? new Date() : undefined
    }
  });
}

export async function logSourceProbe(runId: string, probe: {
  sourceId: string;
  sourceName: string;
  queryText?: string;
  enabled: boolean;
  ok: boolean;
  resultCount: number;
  elapsedMs: number;
  sampleTitle?: string;
  sampleUrl?: string;
  errorMessage?: string;
}) {
  return prisma.sourceProbe.create({
    data: {
      runId,
      sourceId: probe.sourceId,
      sourceName: probe.sourceName,
      queryText: probe.queryText,
      enabled: probe.enabled,
      ok: probe.ok,
      resultCount: probe.resultCount,
      elapsedMs: probe.elapsedMs,
      sampleTitle: probe.sampleTitle,
      sampleUrl: probe.sampleUrl,
      errorMessage: probe.errorMessage
    }
  });
}
