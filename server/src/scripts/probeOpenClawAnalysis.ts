import { prisma } from '../db.js';
import { debugStructuredText, extractJsonPayload, getOpenClawAnalysisOptions } from '../services/llmProvider.js';

const TENDER_SOURCES = ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice', 'ccgp', 'ggzyNational', 'cebpubservice'] as const;

function cleanContentForProbe(content: string): string {
  return content
    .replace(/\r/g, '\n')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+]\([^)]+\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

async function main(): Promise<void> {
  const row = await prisma.hotspot.findFirst({
    where: {
      source: { in: [...TENDER_SOURCES] }
    },
    orderBy: { createdAt: 'desc' }
  });

  if (!row) {
    throw new Error('No tender hotspot found');
  }

  const prompt = `你是 BIM 投标机会分类器。只返回 JSON：
{"isReal":boolean,"relevance":0-100,"relevanceReason":"30字内理由","keywordMentioned":boolean,"importance":"low|medium|high|urgent","summary":"80字内投标要点"}`;
  const content = cleanContentForProbe(`${row.title}\n${row.content}`);
  const startedAt = Date.now();
  const raw = await debugStructuredText([
    { role: 'system', content: prompt },
    { role: 'user', content }
  ], {
    temperature: 0.2,
    maxTokens: 500,
    openclaw: getOpenClawAnalysisOptions({ sessionPrefix: 'probe-analysis' })
  });
  const elapsedMs = Date.now() - startedAt;
  const payload = extractJsonPayload(raw);
  let parsed: unknown = null;
  let parseError: string | null = null;

  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  console.log(JSON.stringify({
    title: row.title,
    elapsedMs,
    rawPreview: raw.slice(0, 1200),
    payloadPreview: payload.slice(0, 1200),
    parseError,
    parsed
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
