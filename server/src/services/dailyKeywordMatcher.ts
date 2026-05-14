export type DailyKeywordMatcherInput = {
  id: string;
  label: string;
  slug: string;
  category: string | null;
  aliases?: string[];
};

export type DailyKeywordHit = {
  keywordId: string;
  label: string;
  slug: string;
  category: string | null;
  count: number;
  matchedTexts: string[];
  hitFields: string[];
};

type MatchableFields = {
  title?: string | null;
  excerpt?: string | null;
  aiSummary?: string | null;
};

function normalizeText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countOccurrences(text: string, term: string): number {
  if (!text || !term) return 0;
  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return Array.from(text.matchAll(pattern)).length;
}

export function matchDailyKeywords(fields: MatchableFields, keywords: DailyKeywordMatcherInput[]): {
  matchedKeywords: DailyKeywordHit[];
  keywordHitPreview: string | null;
} {
  const normalizedFields = {
    title: normalizeText(fields.title || ''),
    excerpt: normalizeText(fields.excerpt || ''),
    aiSummary: normalizeText(fields.aiSummary || ''),
  };

  const hits: Array<DailyKeywordHit & { order: number }> = [];

  for (const [index, keyword] of keywords.entries()) {
    const searchTerms = [...new Set([keyword.label, ...(keyword.aliases || [])].map((item) => normalizeText(item)).filter(Boolean))];
    let count = 0;
    const matchedTexts = new Set<string>();
    const hitFields = new Set<string>();

    for (const term of searchTerms) {
      for (const [fieldName, fieldValue] of Object.entries(normalizedFields)) {
        const fieldCount = countOccurrences(fieldValue, term);
        if (fieldCount <= 0) continue;
        count += fieldCount;
        matchedTexts.add(term);
        hitFields.add(fieldName);
      }
    }

    if (count <= 0) continue;
    hits.push({
      order: index,
      keywordId: keyword.id,
      label: keyword.label,
      slug: keyword.slug,
      category: keyword.category,
      count,
      matchedTexts: [...matchedTexts],
      hitFields: [...hitFields],
    });
  }

  hits.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.order - b.order;
  });

  return {
    matchedKeywords: hits.map(({ order, ...rest }) => rest),
    keywordHitPreview: buildKeywordHitPreview(hits),
  };
}

export function buildKeywordHitPreview(hits: DailyKeywordHit[]): string | null {
  if (hits.length === 0) return null;
  return hits
    .slice(0, 4)
    .map((item) => `${item.label} ${item.count}`)
    .join('｜');
}
