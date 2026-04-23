import { prisma } from '../db.js';
import { analyzeContent, expandKeyword, preMatchKeyword } from '../services/ai.js';

const TENDER_SOURCES = ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice'] as const;

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getLimit(): number {
  const raw = process.argv.find((arg) => arg.startsWith('--limit='));
  const value = raw ? Number.parseInt(raw.split('=')[1] || '', 10) : 50;
  return Number.isFinite(value) ? Math.max(1, Math.min(value, 500)) : 50;
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const limit = getLimit();

  const rows = await prisma.hotspot.findMany({
    where: {
      source: { in: [...TENDER_SOURCES] },
      OR: [
        { relevanceReason: { contains: '未配置 AI 服务，使用默认分数' } },
        { relevanceReason: { contains: '未配置 AI 服务，使用规则投标分析' } },
        { relevanceReason: { contains: 'AI 分析失败，使用默认分数' } },
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

  const preview: Array<Record<string, unknown>> = [];
  let updated = 0;

  for (const row of rows) {
    const keyword = row.keyword?.text || 'BIM';
    const expanded = await expandKeyword(keyword);
    const fullText = `${row.title}\n${row.content}`;
    const preMatch = preMatchKeyword(fullText, expanded);
    const analysis = await analyzeContent(fullText, keyword, preMatch);

    preview.push({
      id: row.id,
      title: row.title,
      oldRelevance: row.relevance,
      newRelevance: analysis.relevance,
      oldReason: row.relevanceReason,
      newReason: analysis.relevanceReason,
    });

    if (!apply) continue;

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
    updated += 1;
  }

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    limit,
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
