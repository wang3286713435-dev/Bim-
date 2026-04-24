import axios from 'axios';
import * as cheerio from 'cheerio';

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function renderTemplate(value: string | undefined, query: string): string | undefined {
  return value?.replaceAll('{query}', query);
}

function classifyRisk(status: number, text: string): string[] {
  const risks: string[] = [];
  if ([401, 403].includes(status)) risks.push('auth_or_waf');
  if ([429].includes(status)) risks.push('rate_limited');
  if ([502, 503, 504].includes(status)) risks.push('gateway_unstable');
  if (/验证码|滑块|安全验证|访问过于频繁|forbidden|waf|captcha/i.test(text)) risks.push('anti_bot_signal');
  if (text.length < 500) risks.push('short_response');
  return [...new Set(risks)];
}

function extractPageSummary(html: string) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const links = $('a')
    .slice(0, 20)
    .map((_, element) => ({
      text: $(element).text().replace(/\s+/g, ' ').trim().slice(0, 80),
      href: $(element).attr('href') || ''
    }))
    .get()
    .filter((item) => item.text || item.href);
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  return {
    title,
    links,
    textPreview: bodyText.slice(0, 800)
  };
}

async function main(): Promise<void> {
  const rawUrl = getArg('url');
  const query = getArg('query', 'BIM') || 'BIM';
  const method = (getArg('method', 'get') || 'get').toLowerCase();
  const rawBody = getArg('body');
  const timeout = Number.parseInt(getArg('timeout', '15000') || '15000', 10);

  if (!rawUrl) {
    throw new Error('Missing --url. Example: npm run probe:tender-source-candidate -- --url="https://example.com/search?q={query}" --query=BIM');
  }

  const url = renderTemplate(rawUrl, encodeURIComponent(query))!;
  const bodyText = renderTemplate(rawBody, query);
  const startedAt = Date.now();

  const response = await axios.request({
    method,
    url,
    data: bodyText ? JSON.parse(bodyText) : undefined,
    timeout: Number.isFinite(timeout) ? timeout : 15000,
    validateStatus: () => true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
      'Content-Type': bodyText ? 'application/json;charset=UTF-8' : undefined
    }
  });

  const elapsedMs = Date.now() - startedAt;
  const contentType = String(response.headers['content-type'] || '');
  const raw = typeof response.data === 'string' ? response.data : JSON.stringify(response.data).slice(0, 20_000);
  const pageSummary = contentType.includes('html') || /^\s*</.test(raw)
    ? extractPageSummary(raw)
    : undefined;

  console.log(JSON.stringify({
    url,
    query,
    method,
    status: response.status,
    elapsedMs,
    contentType,
    size: raw.length,
    risks: classifyRisk(response.status, raw),
    page: pageSummary,
    jsonPreview: pageSummary ? undefined : raw.slice(0, 1200),
    recommendation: hasFlag('json-only') ? undefined : [
      response.status >= 200 && response.status < 300 ? 'HTTP 可访问' : 'HTTP 状态异常，先确认是否需要代理/登录/请求头',
      classifyRisk(response.status, raw).length ? '存在反爬或不稳定信号，接入时必须配置降级策略' : '未发现明显反爬信号',
      pageSummary?.links?.length ? '可继续分析列表链接结构' : '未发现明显链接，可能需要 JSON 解析或 JS 渲染'
    ].filter(Boolean)
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
