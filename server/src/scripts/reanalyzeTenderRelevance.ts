import { prisma } from '../db.js';
import { analyzeContent, preMatchKeyword } from '../services/ai.js';
import { recordAIAnalysisLog } from '../services/aiAnalysisLogger.js';

const TENDER_SOURCES = ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice'] as const;

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getLimit(): number {
  const raw = process.argv.find((arg) => arg.startsWith('--limit='));
  const value = raw ? Number.parseInt(raw.split('=')[1] || '', 10) : 50;
  return Number.isFinite(value) ? Math.max(1, Math.min(value, 500)) : 50;
}

function getConcurrency(): number {
  const raw = process.argv.find((arg) => arg.startsWith('--concurrency='));
  const configured = raw
    ? Number.parseInt(raw.split('=')[1] || '', 10)
    : Number.parseInt(process.env.TENDER_AI_CONCURRENCY || '2', 10);
  return Number.isFinite(configured) ? Math.max(1, Math.min(configured, 4)) : 2;
}

async function mapLimit<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}

function buildReanalysisKeywords(keyword: string): string[] {
  const terms = new Set<string>([keyword]);
  if (/BIM/i.test(keyword)) terms.add('BIM');
  if (keyword.includes('建筑信息模型')) {
    terms.add('建筑信息模型');
    terms.add('BIM');
  }
  for (const term of ['设计', '正向设计', '全过程咨询', '咨询', '施工应用', '深化设计', '技术服务', '智慧建造', 'CIM']) {
    if (keyword.includes(term)) terms.add(term);
  }
  return [...terms];
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const limit = getLimit();
  const concurrency = getConcurrency();

  const rows = await prisma.hotspot.findMany({
    where: {
      source: { in: [...TENDER_SOURCES] },
      OR: [
        { relevanceReason: { contains: '未配置 AI 服务，使用默认分数' } },
        { relevanceReason: { contains: '未配置 AI 服务，使用规则投标分析' } },
        { relevanceReason: { contains: 'AI 分析失败，使用默认分数' } },
        { relevanceReason: { contains: 'AI 分析超时或失败，使用规则投标分析' } },
      ],
    },
    include: {
      keyword: {
        select: { text: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const results = await mapLimit(rows, concurrency, async (row) => {
    const keyword = row.keyword?.text || 'BIM';
    const expanded = buildReanalysisKeywords(keyword);
    const fullText = `${row.title}\n${row.content}`;
    const preMatch = preMatchKeyword(fullText, expanded);
    const analysis = await analyzeContent(fullText, keyword, preMatch);

    const preview = {
      id: row.id,
      title: row.title,
      oldRelevance: row.relevance,
      newRelevance: analysis.relevance,
      oldReason: row.relevanceReason,
      newReason: analysis.relevanceReason,
    };

    if (!apply) {
      return { preview, updated: false };
    }

    await prisma.hotspot.update({
      where: { id: row.id },
      data: {
        isReal: analysis.isReal,
        relevance: analysis.relevance,
        relevanceReason: analysis.relevanceReason,
        keywordMentioned: analysis.keywordMentioned,
        importance: analysis.importance,
        summary: analysis.summary,
      },
    });
    await recordAIAnalysisLog({
      hotspotId: row.id,
      source: row.source,
      keywordText: keyword,
      title: row.title,
      url: row.url,
      analysis,
    });
    return { preview, updated: true };
  });

  const preview = results.map((item) => item.preview);
  const updated = results.filter((item) => item.updated).length;

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    limit,
    concurrency,
    totalMatched: rows.length,
    updated,
    preview: preview.slice(0, 20),
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
