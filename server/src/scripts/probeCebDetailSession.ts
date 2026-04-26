import dotenv from 'dotenv';
import { fetchCebDetailViaApi, getCebDetailSessionSnapshot, searchCebpubservice } from '../services/tenderSources.js';
import type { SearchResult } from '../types.js';

dotenv.config();

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function toIsoMinute(value: Date | undefined): string | null {
  if (!value) return null;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

async function resolveProbeBase(uuid?: string, query = 'BIM'): Promise<{ uuid: string; base: SearchResult } | null> {
  if (uuid) {
    return {
      uuid,
      base: {
        title: `CEB detail probe ${uuid}`,
        content: '',
        url: `https://ctbpsp.com/#/bulletinDetail?uuid=${encodeURIComponent(uuid)}&inpvalue=&dataSource=0&tenderAgency=`,
        source: 'cebpubservice',
        sourceId: uuid,
        tender: {
          platform: '中国招标投标公共服务平台'
        }
      }
    };
  }

  const rows = await searchCebpubservice(query, 1);
  const first = rows.find((row) => row.sourceId);
  return first?.sourceId ? { uuid: first.sourceId, base: first } : null;
}

async function main(): Promise<void> {
  const uuid = getArg('uuid');
  const query = getArg('query', 'BIM') || 'BIM';
  const startedAt = Date.now();
  const session = getCebDetailSessionSnapshot();
  const resolved = await resolveProbeBase(uuid, query);

  if (!resolved) {
    console.log(JSON.stringify({
      source: 'cebpubservice',
      ok: false,
      query,
      session,
      error: 'no CEB sample uuid resolved'
    }, null, 2));
    return;
  }

  const detail = await fetchCebDetailViaApi(resolved.uuid, resolved.base);
  console.log(JSON.stringify({
    source: 'cebpubservice',
    ok: detail.status === 'ok',
    uuid: resolved.uuid,
    query,
    elapsedMs: Date.now() - startedAt,
    session,
    detail: {
      status: detail.status,
      message: detail.message,
      contentSize: detail.content?.length ?? 0,
      tender: detail.tender ? {
        unit: detail.tender.unit,
        budgetWan: detail.tender.budgetWan,
        deadline: toIsoMinute(detail.tender.deadline),
        bidOpenTime: toIsoMinute(detail.tender.bidOpenTime),
        projectCode: detail.tender.projectCode,
        contact: detail.tender.contact,
        phone: detail.tender.phone,
        serviceScope: detail.tender.serviceScope,
        detailSource: detail.tender.detailSource
      } : null
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
