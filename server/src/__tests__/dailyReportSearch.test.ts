import { describe, expect, it } from 'vitest';
import { buildDailyReportWhere } from '../services/dailyReports.js';

describe('buildDailyReportWhere', () => {
  it('adds a cross-report search clause that covers report text and related articles', () => {
    const where = buildDailyReportWhere({ searchText: 'Revit' });

    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.objectContaining({ contains: 'Revit' }) }),
      expect.objectContaining({ executiveSummary: expect.objectContaining({ contains: 'Revit' }) }),
      expect.objectContaining({ articles: expect.objectContaining({ some: expect.any(Object) }) }),
    ]));

    const articleClause = (where.OR || []).find((item) => 'articles' in item) as { articles?: { some?: Record<string, unknown> } } | undefined;
    expect(articleClause?.articles?.some?.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.objectContaining({ contains: 'Revit' }) }),
      expect.objectContaining({ summary: expect.objectContaining({ contains: 'Revit' }) }),
      expect.objectContaining({ keywordHits: expect.objectContaining({ some: expect.any(Object) }) }),
    ]));
  });
});
