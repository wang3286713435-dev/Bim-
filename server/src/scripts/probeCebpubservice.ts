import dotenv from 'dotenv';
import axios from 'axios';
import { searchCebpubservice } from '../services/tenderSources.js';

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

function classifyCebPage(text: string, status: number): string {
  if (status >= 400) return `http_${status}`;
  if (/很抱歉，此页面暂时找不到|Sorry, the site now can not be accessed/i.test(text)) return 'pagination_challenge_or_invalid_page';
  if (/Punish-Type|_waf_|potential threats|访问被阻断|security|405/i.test(text)) return 'waf_challenge';
  if (/VAPTCHA|captcha\/captcha|vaptcha/i.test(text)) return 'vaptcha_required';
  if (/table_text/.test(text)) return 'ok_list_html';
  return 'unknown';
}

async function probePagination(query: string): Promise<{ status: number; size: number; classification: string }> {
  const params = new URLSearchParams({
    searchDate: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    dates: '300',
    categoryId: '88',
    industryName: '',
    area: '',
    status: '',
    publishMedia: '',
    sourceInfo: '',
    showStatus: '1',
    word: query,
    page: '2'
  });

  const response = await axios.get<string>(`https://bulletin.cebpubservice.com/xxfbcmses/search/bulletin.html?${params.toString()}`, {
    timeout: 15000,
    responseType: 'text',
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: 'https://bulletin.cebpubservice.com/'
    }
  });

  const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  return {
    status: response.status,
    size: raw.length,
    classification: classifyCebPage(raw, response.status)
  };
}

async function main(): Promise<void> {
  const query = getArg('query', 'BIM') || 'BIM';
  const limit = Number.parseInt(getArg('limit', '8') || '8', 10);
  const startedAt = Date.now();
  const rows = await searchCebpubservice(query, Number.isFinite(limit) ? limit : 8);
  const pagination = await probePagination(query).catch((error) => ({
    status: 0,
    size: 0,
    classification: `probe_error:${error instanceof Error ? error.message : String(error)}`
  }));

  const coverage = {
    total: rows.length,
    unit: rows.filter((row) => row.tender?.unit).length,
    budget: rows.filter((row) => row.tender?.budgetWan != null).length,
    deadline: rows.filter((row) => row.tender?.deadline || row.tender?.bidOpenTime).length,
    serviceScope: rows.filter((row) => row.tender?.serviceScope).length,
    detailSource: rows.filter((row) => row.tender?.detailSource).length
  };

  console.log(JSON.stringify({
    source: 'cebpubservice',
    query,
    elapsedMs: Date.now() - startedAt,
    detailFetchEnabled: process.env.CEB_DETAIL_FETCH_ENABLED === 'true',
    pagination,
    coverage,
    samples: rows.map((row) => ({
      title: row.title,
      url: row.url,
      publishedAt: toIsoMinute(row.publishedAt),
      sourceId: row.sourceId,
      type: row.tender?.type,
      noticeType: row.tender?.noticeType,
      region: row.tender?.region,
      deadline: toIsoMinute(row.tender?.deadline),
      bidOpenTime: toIsoMinute(row.tender?.bidOpenTime),
      serviceScope: row.tender?.serviceScope,
      detailSource: row.tender?.detailSource
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
