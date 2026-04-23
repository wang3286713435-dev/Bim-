import { prisma } from '../db.js';

const DEFAULT_BIM_KEYWORDS = [
  'BIM设计',
  'BIM正向设计',
  'BIM全过程咨询',
  'BIM施工应用',
  'BIM深化设计',
  'BIM数字化交付',
  'EPC+BIM',
  '建筑信息模型',
  'BIM技术服务',
  'BIM咨询',
  '智慧建造BIM'
] as const;

export async function ensureDefaultKeywords(): Promise<void> {
  const category = 'bim-tender';

  for (const text of DEFAULT_BIM_KEYWORDS) {
    await prisma.keyword.upsert({
      where: { text },
      update: {
        category,
        isActive: true
      },
      create: {
        text,
        category,
        isActive: true
      }
    });
  }

  console.log(`✅ Ensured ${DEFAULT_BIM_KEYWORDS.length} default BIM keywords`);
}

export { DEFAULT_BIM_KEYWORDS };
