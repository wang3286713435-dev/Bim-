import { prisma } from '../db.js';
import { syncHotspotsToFeishuBitable, type FeishuHotspot } from '../services/feishu.js';

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getLimit(): number | undefined {
  const arg = process.argv.find(item => item.startsWith('--limit='));
  if (!arg) return undefined;
  const value = Number(arg.split('=')[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const clearFirst = hasFlag('--clear');
  const limit = getLimit();

  const rows = await prisma.hotspot.findMany({
    where: {
      source: {
        in: ['szggzy', 'szygcgpt', 'guangdong', 'gzebpubservice']
      }
    },
    orderBy: [
      { createdAt: 'desc' },
      { relevance: 'desc' }
    ],
    take: limit,
    include: {
      keyword: true
    }
  });

  const hotspots = rows as unknown as FeishuHotspot[];
  const result = await syncHotspotsToFeishuBitable(hotspots, { clearFirst });

  console.log(JSON.stringify({
    clearFirst,
    totalHotspots: hotspots.length,
    ...result
  }, null, 2));
}

main()
  .catch(error => {
    console.error('Feishu bitable sync failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
