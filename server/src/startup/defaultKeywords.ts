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
  '智慧建造BIM',
  '机场航站楼 BIM',
  '体育场馆 BIM',
  '展览馆 BIM',
  '医院 BIM',
  '大型商业综合体 BIM',
  '城市轨道交通 BIM',
  '隧道 BIM',
  '大型桥梁 BIM',
  '城市综合管廊 BIM',
  '大型污水处理厂 BIM',
  '装配式建筑工程',
  '工程总承包 EPC',
  '总承包工程',
  '全过程工程咨询',
  '施工模拟',
  '竣工模型交付',
  '数字孪生',
  '管线综合',
  '智慧运维'
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
