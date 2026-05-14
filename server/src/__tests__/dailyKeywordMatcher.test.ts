import { describe, expect, it } from 'vitest';
import { buildKeywordHitPreview, matchDailyKeywords, type DailyKeywordMatcherInput } from '../services/dailyKeywordMatcher.js';

const KEYWORDS: DailyKeywordMatcherInput[] = [
  { id: 'k1', label: 'BIM', slug: 'bim', category: 'core', aliases: ['建筑信息模型'] },
  { id: 'k2', label: '数字孪生', slug: 'digital-twin', category: 'trend', aliases: ['Digital Twin'] },
  { id: 'k3', label: 'Revit', slug: 'revit', category: 'software', aliases: ['Autodesk Revit'] },
];

describe('matchDailyKeywords', () => {
  it('matches across title, excerpt, and ai summary', () => {
    const result = matchDailyKeywords({
      title: 'AI×BIM 融合推动数字孪生落地',
      excerpt: '文章分析建筑信息模型在工程协同中的价值。',
      aiSummary: '总结了 Digital Twin 与 Revit 协同趋势。'
    }, KEYWORDS);

    expect(result.matchedKeywords).toHaveLength(3);
    expect(result.matchedKeywords.map((item) => item.label)).toEqual(['BIM', '数字孪生', 'Revit']);
    expect(result.matchedKeywords.find((item) => item.label === 'BIM')?.count).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates aliases back to a single keyword record', () => {
    const result = matchDailyKeywords({
      title: 'Autodesk Revit 与 Revit 参数化建模',
      excerpt: 'Revit 在机电建模中继续扩展。',
      aiSummary: '文章围绕 Autodesk Revit 工作流。'
    }, KEYWORDS);

    expect(result.matchedKeywords).toHaveLength(1);
    expect(result.matchedKeywords[0].label).toBe('Revit');
    expect(result.matchedKeywords[0].matchedTexts).toEqual(expect.arrayContaining(['Revit', 'Autodesk Revit']));
  });
});

describe('buildKeywordHitPreview', () => {
  it('builds a compact preview string from keyword hits', () => {
    const preview = buildKeywordHitPreview([
      { keywordId: 'k1', label: 'BIM', slug: 'bim', category: 'core', count: 4, matchedTexts: ['BIM'], hitFields: ['title'] },
      { keywordId: 'k2', label: '数字孪生', slug: 'digital-twin', category: 'trend', count: 2, matchedTexts: ['数字孪生'], hitFields: ['excerpt'] },
    ]);

    expect(preview).toBe('BIM 4｜数字孪生 2');
  });
});
