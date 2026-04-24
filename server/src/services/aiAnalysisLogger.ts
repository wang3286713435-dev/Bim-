import { prisma } from '../db.js';
import type { AIAnalysis } from '../types.js';

type AnalysisTelemetry = NonNullable<AIAnalysis['telemetry']>;

export interface AIAnalysisLogInput {
  runId?: string | null;
  hotspotId?: string | null;
  source?: string | null;
  keywordText?: string | null;
  title?: string | null;
  url?: string | null;
  analysis: AIAnalysis;
}

function trimText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.slice(0, maxLength);
}

function inferTelemetry(analysis: AIAnalysis): AnalysisTelemetry {
  if (analysis.telemetry) return analysis.telemetry;
  const reason = analysis.relevanceReason || '';
  const fallbackUsed = /未配置 AI 服务|AI 分析超时或失败|规则投标分析|规则判断/.test(reason);
  return {
    provider: fallbackUsed ? 'rule' : 'unknown',
    status: fallbackUsed ? 'fallback' : 'success',
    fallbackUsed,
    attemptCount: 0,
    elapsedMs: 0
  };
}

export async function recordAIAnalysisLog(input: AIAnalysisLogInput): Promise<string | null> {
  const telemetry = inferTelemetry(input.analysis);

  try {
    const row = await prisma.aiAnalysisLog.create({
      data: {
        runId: input.runId ?? null,
        hotspotId: input.hotspotId ?? null,
        source: input.source ?? null,
        keywordText: trimText(input.keywordText, 120),
        title: trimText(input.title, 300),
        url: trimText(input.url, 500),
        provider: telemetry.provider,
        status: telemetry.status,
        fallbackUsed: telemetry.fallbackUsed,
        attemptCount: telemetry.attemptCount,
        elapsedMs: telemetry.elapsedMs,
        relevance: input.analysis.relevance,
        importance: input.analysis.importance,
        reason: trimText(input.analysis.relevanceReason, 500),
        errorMessage: trimText(telemetry.errorMessage, 500)
      }
    });

    return row.id;
  } catch (error) {
    console.warn('Failed to record AI analysis log:', error instanceof Error ? error.message : error);
    return null;
  }
}
