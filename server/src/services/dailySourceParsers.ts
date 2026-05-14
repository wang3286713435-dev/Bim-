import * as cheerio from 'cheerio';

export type ParsedDailySourceRow = {
  title: string;
  url: string;
  excerpt: string;
  publishedAt: Date | null;
  rawCategory: string | null;
};

function normalizeText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractReadableContentFromHtml(html: string): string {
  const $ = cheerio.load(html);
  const selectors = [
    'article .entry-content',
    '.entry-content',
    '.post-content',
    '.article-content',
    '.single-post-content',
    '.content',
    'main article',
    'article',
    'main',
    'body',
  ];

  let best = '';
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const text = normalizeText($(element).text());
      if (text.length > best.length) best = text;
    });
    if (best.length >= 400) break;
  }

  return best;
}

function toAbsoluteUrl(baseUrl: string, href: string): string {
  return new URL(href, baseUrl).toString();
}

function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const normalized = value.trim().replace(/\./g, '-').replace(/\//g, '-');
  const match = normalized.match(/\d{4}-\d{2}-\d{2}/);
  if (!match) return null;
  const date = new Date(`${match[0]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseBimboxTopicHtml(html: string): ParsedDailySourceRow[] {
  const $ = cheerio.load(html);
  return $('article')
    .map((_, element) => {
      const titleLink = $(element).find('.entry-title a').first();
      const dateText = $(element).find('.time .count').first().text();
      const excerpt = normalizeText($(element).find('.entry-excerpt').text());
      const title = normalizeText(titleLink.text());
      const href = titleLink.attr('href');
      if (!title || !href) return null;
      return {
        title,
        url: href,
        excerpt,
        publishedAt: parseDate(dateText),
        rawCategory: normalizeText($(element).find('.entry-category-2').text()) || null
      } satisfies ParsedDailySourceRow;
    })
    .get()
    .filter((item): item is ParsedDailySourceRow => Boolean(item));
}

export function parseShbimCenterListHtml(html: string, baseUrl: string): ParsedDailySourceRow[] {
  const $ = cheerio.load(html);
  const rows: Array<ParsedDailySourceRow | null> = $('a[href$=".html"]')
    .map((_, element) => {
      const href = $(element).attr('href');
      const text = normalizeText($(element).text());
      if (!href || !text || text.length < 8) return null;

      const publishedAt = parseDate(text);
      return {
        title: text.replace(/\s*\[?\d{4}-\d{2}-\d{2}\]?[\s\S]*$/u, '').trim() || text,
        url: toAbsoluteUrl(baseUrl, href),
        excerpt: text,
        publishedAt,
        rawCategory: null,
      } satisfies ParsedDailySourceRow;
    })
    .get();
  return rows.filter((item): item is ParsedDailySourceRow => Boolean(item));
}

export function parseFuzorSupportHtml(html: string, baseUrl: string): ParsedDailySourceRow[] {
  const $ = cheerio.load(html);
  const nodes = $('.service_m1 .main .item').length > 0 ? $('.service_m1 .main .item') : $('.item');
  return nodes
    .map((_, element) => {
      const titleLink = $(element).find('a.title').first();
      const href = titleLink.attr('href');
      const title = normalizeText(titleLink.text() || titleLink.attr('title') || '');
      if (!href || !title) return null;

      return {
        title,
        url: toAbsoluteUrl(baseUrl, href),
        excerpt: normalizeText($(element).find('.desc').first().text()),
        publishedAt: parseDate($(element).find('.time').first().text()),
        rawCategory: normalizeText($(element).find('.tagleft').first().text()) || null
      } satisfies ParsedDailySourceRow;
    })
    .get()
    .filter((item): item is ParsedDailySourceRow => Boolean(item));
}

type ChinaBimListResponse = {
  code?: number;
  data?: {
    list?: Array<{
      id: string;
      title?: string;
      digest?: string;
      releaseDate?: string;
      newsReleaseArea?: string;
    }>;
  };
};

export function parseChinaBimListResponse(payload: ChinaBimListResponse, baseUrl: string): ParsedDailySourceRow[] {
  const rows: Array<ParsedDailySourceRow | null> = (payload.data?.list || [])
    .map((item) => {
      if (!item.id || !item.title) return null;
      return {
        title: normalizeText(item.title),
        url: toAbsoluteUrl(baseUrl, `/en/news/${item.id}`),
        excerpt: normalizeText(item.digest || ''),
        publishedAt: parseDate(item.releaseDate || ''),
        rawCategory: normalizeText(item.newsReleaseArea || '') || null
      } satisfies ParsedDailySourceRow;
    });
  return rows.filter((item): item is ParsedDailySourceRow => Boolean(item));
}

type WordPressPost = {
  date?: string;
  link?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
};

export function parseWordPressPosts(posts: WordPressPost[]): ParsedDailySourceRow[] {
  const rows: Array<ParsedDailySourceRow | null> = posts
    .map((item) => {
      if (!item.link || !item.title?.rendered) return null;
      return {
        title: normalizeText(item.title.rendered),
        url: item.link,
        excerpt: normalizeText(item.excerpt?.rendered || ''),
        publishedAt: parseDate(item.date || ''),
        rawCategory: null,
      } satisfies ParsedDailySourceRow;
    });
  return rows.filter((item): item is ParsedDailySourceRow => Boolean(item));
}
