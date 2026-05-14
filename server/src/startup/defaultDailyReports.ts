import { prisma } from '../db.js';
import { DAILY_SOURCE_DEFINITIONS, DEFAULT_DAILY_KEYWORDS } from '../services/dailyReportRegistry.js';

export async function ensureDefaultDailyReportData(): Promise<void> {
  for (const source of DAILY_SOURCE_DEFINITIONS) {
    await prisma.dailySource.upsert({
      where: { id: source.id },
      update: {
        name: source.name,
        homepage: source.homepage,
        listUrl: source.listUrl,
        sourceType: source.sourceType,
        isActive: true,
      },
      create: {
        id: source.id,
        name: source.name,
        homepage: source.homepage,
        listUrl: source.listUrl,
        sourceType: source.sourceType,
        isActive: true,
      }
    });
  }

  for (const keyword of DEFAULT_DAILY_KEYWORDS) {
    await prisma.dailyKeyword.upsert({
      where: { slug: keyword.slug },
      update: {
        label: keyword.label,
        aliasesJson: JSON.stringify(keyword.aliases),
        category: keyword.category,
        sortOrder: keyword.sortOrder,
        isActive: true,
      },
      create: {
        label: keyword.label,
        slug: keyword.slug,
        aliasesJson: JSON.stringify(keyword.aliases),
        category: keyword.category,
        sortOrder: keyword.sortOrder,
        isActive: true,
      }
    });
  }

  console.log(`✅ Ensured ${DAILY_SOURCE_DEFINITIONS.length} BIM daily sources and ${DEFAULT_DAILY_KEYWORDS.length} daily keywords`);
}
