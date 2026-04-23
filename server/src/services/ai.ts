import type { AIAnalysis } from '../types.js';
import { generateStructuredJson } from './llmProvider.js';

// ========== Query Expansion（查询扩展） ==========

/**
 * 使用 AI 将关键词扩展为多个变体，用于文本预过滤。
 * 返回扩展后的关键词列表（含原始关键词）。
 * 结果会被缓存，同一关键词不会重复调用 AI。
 */
const expansionCache = new Map<string, string[]>();

function hasUsableOpenRouterKey(): boolean {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return Boolean(key && key !== 'your_openrouter_api_key_here');
}

export async function expandKeyword(keyword: string): Promise<string[]> {
  // 缓存命中
  if (expansionCache.has(keyword)) {
    return expansionCache.get(keyword)!;
  }

  // 不管 AI 是否可用，先提取基础核心词
  const coreTerms = extractCoreTerms(keyword);

  if (!hasUsableOpenRouterKey()) {
    if (process.env.AI_PROVIDER === 'openclaw') {
      // OpenClaw 模式下继续尝试调用本地 agent
    } else {
    const result = [keyword, ...coreTerms];
    expansionCache.set(keyword, result);
    return result;
    }
  }

  try {
    const parsed = await generateStructuredJson<string[]>([
        {
          role: 'system',
          content: `你是一个搜索查询扩展专家。给定一个监控关键词，生成该关键词的变体和相关检索词，用于文本匹配。

规则：
1. 包含原始关键词的各种写法（大小写、空格、连字符变体）
2. 包含关键词的核心组成词（拆分后的各个有意义的词）
3. 包含常见别称、缩写、中英文对照
4. 不要加入泛化词（比如关键词是"Claude Sonnet 4.6"，不要加"AI模型"这种泛化词）
5. 总数控制在 5-15 个

输出 JSON 数组，只输出 JSON，不要有其他内容。
示例输入："Claude Sonnet 4.6"
示例输出：["Claude Sonnet 4.6", "Claude Sonnet", "Sonnet 4.6", "claude-sonnet-4.6", "Claude 4.6", "Anthropic Sonnet"]`
        },
        {
          role: 'user',
          content: keyword
        }
      ], { temperature: 0.2, maxTokens: 300 });

    const expanded = [...new Set([keyword, ...coreTerms, ...parsed.map(s => s.trim()).filter(Boolean)])];
    expansionCache.set(keyword, expanded);
    console.log(`  🔍 Query expansion for "${keyword}": ${expanded.length} variants`);
    return expanded;
  } catch (error) {
    console.error('Query expansion failed:', error);
  }

  // Fallback：使用基础核心词
  const fallback = [keyword, ...coreTerms];
  expansionCache.set(keyword, fallback);
  return fallback;
}

/**
 * 从关键词中提取核心词（纯文本方式，不依赖 AI）
 */
function extractCoreTerms(keyword: string): string[] {
  const terms: string[] = [];
  // 按空格、连字符、下划线分割
  const parts = keyword.split(/[\s\-_\/\\·]+/).filter(p => p.length >= 2);
  if (parts.length > 1) {
    terms.push(...parts);
    // 两两组合
    for (let i = 0; i < parts.length - 1; i++) {
      terms.push(parts[i] + ' ' + parts[i + 1]);
    }
  }

  const upperKeyword = keyword.toUpperCase();
  if (upperKeyword.includes('BIM')) terms.push('BIM');
  if (upperKeyword.includes('EPC')) terms.push('EPC');
  if (keyword.includes('建筑信息模型')) terms.push('建筑信息模型', 'BIM');

  const chineseTerms = ['设计', '正向设计', '全过程', '全过程咨询', '咨询', '施工', '施工应用', '深化设计', '数字化交付', '技术服务', '智慧建造', 'CIM'];
  for (const term of chineseTerms) {
    if (keyword.includes(term)) terms.push(term);
  }

  // 去重，排除原始关键词本身
  return [...new Set(terms)].filter(t => t.toLowerCase() !== keyword.toLowerCase());
}

// ========== 关键词预匹配 ==========

/**
 * 检查文本中是否包含任一扩展关键词（不区分大小写）。
 * 返回是否匹配以及匹配到的词。
 */
export function preMatchKeyword(text: string, expandedKeywords: string[]): { matched: boolean; matchedTerms: string[] } {
  const lowerText = text.toLowerCase();
  const matchedTerms: string[] = [];
  for (const kw of expandedKeywords) {
    if (lowerText.includes(kw.toLowerCase())) {
      matchedTerms.push(kw);
    }
  }
  return { matched: matchedTerms.length > 0, matchedTerms };
}

// ========== AI 内容分析（关键词感知） ==========

function buildAnalysisPrompt(keyword: string, preMatchResult: { matched: boolean; matchedTerms: string[] }): string {
  const matchHint = preMatchResult.matched 
    ? `\n注意：文本预匹配发现内容中包含以下关键词变体：${preMatchResult.matchedTerms.join('、')}` 
    : `\n注意：文本预匹配发现内容中未直接提及关键词"${keyword}"的任何变体，请特别严格审核相关性。`;

  return `你是建筑/BIM企业投标经营助手。判断公告是否是【${keyword}】相关投标机会，并输出投标要点。

${matchHint}

评分规则：
- isReal=false：新闻、政策、结果公示、坏页面、无投标价值页面。
- relevance 是投标线索价值分：90+立即跟进；75-89进入商机初筛；60-74人工补字段；40-59观察；低于40过滤。
- importance：urgent=临近截止或高度匹配；high=值得跟进；medium=待补充核验；low=观察。
- summary 必须写成“投标要点”，包含能识别出的项目、单位、地区、预算/截止、BIM服务范围、建议动作；缺失字段要说明需人工补齐。

请以 JSON 格式输出：
{
  "isReal": true/false,
  "relevance": 0-100,
  "relevanceReason": "投标价值打分理由，提到公告阶段、BIM服务内容、字段完整度或风险",
  "keywordMentioned": true/false,
  "importance": "low/medium/high/urgent",
  "summary": "投标要点：..."
}

只输出 JSON，不要有其他内容。`;
}

function buildRuleBasedTenderAnalysis(content: string, matchResult: { matched: boolean; matchedTerms: string[] }, reason: string): AIAnalysis {
  const hasDeadline = /截止|递交|开标|投标文件|报名/.test(content);
  const hasBudget = /预算|控制价|最高限价|金额|万元|元/.test(content);
  const isResultLike = /中标结果|成交结果|候选人公示|合同公告|结果公示/.test(content);
  const relevance = isResultLike ? 45 : matchResult.matched ? (hasDeadline || hasBudget ? 82 : 72) : 35;
  const importance: AIAnalysis['importance'] = relevance >= 82 ? 'high' : relevance >= 60 ? 'medium' : 'low';

  return {
    isReal: !isResultLike && relevance >= 40,
    relevance,
    relevanceReason: `${reason}；规则判断：${matchResult.matched ? `命中 ${matchResult.matchedTerms.join('、')}` : '未直接命中关键词'}，${hasBudget ? '包含预算/金额线索' : '预算字段待补齐'}，${hasDeadline ? '包含截止/开标线索' : '截止时间待补齐'}。`,
    keywordMentioned: matchResult.matched,
    importance,
    summary: `投标要点：${content.slice(0, 90)}${content.length > 90 ? '...' : ''}；建议人工核对招标单位、预算、截止时间和BIM服务范围。`
  };
}

export async function analyzeContent(content: string, keyword: string, preMatchResult?: { matched: boolean; matchedTerms: string[] }): Promise<AIAnalysis> {
  // 默认预匹配结果
  const matchResult = preMatchResult ?? { matched: false, matchedTerms: [] };

  if (!hasUsableOpenRouterKey() && process.env.AI_PROVIDER !== 'openclaw') {
    console.warn('OpenRouter API key not configured, using fallback analysis');
    return buildRuleBasedTenderAnalysis(content, matchResult, '未配置 AI 服务，使用规则投标分析');
  }

  try {
    const prompt = buildAnalysisPrompt(keyword, matchResult);
    const parsed = await generateStructuredJson<AIAnalysis>([
        {
          role: 'system',
          content: prompt
        },
        {
          role: 'user',
          content: content.slice(0, 2000) // 限制内容长度
        }
      ], { temperature: 0.2, maxTokens: 500 });

    return {
      isReal: Boolean(parsed.isReal),
      relevance: Math.min(100, Math.max(0, Number(parsed.relevance) || 0)),
      relevanceReason: String(parsed.relevanceReason || '').slice(0, 200),
      keywordMentioned: Boolean(parsed.keywordMentioned),
      importance: ['low', 'medium', 'high', 'urgent'].includes(parsed.importance)
        ? parsed.importance
        : 'low',
      summary: String(parsed.summary || '').slice(0, 150)
    };
  } catch (error) {
    console.error('AI analysis failed:', error);
    return buildRuleBasedTenderAnalysis(content, matchResult, 'AI 分析超时或失败，使用规则投标分析');
  }
}

export async function batchAnalyze(contents: string[], keyword: string, expandedKeywords?: string[]): Promise<AIAnalysis[]> {
  // 并行分析，但限制并发数
  const batchSize = 3;
  const results: AIAnalysis[] = [];

  for (let i = 0; i < contents.length; i += batchSize) {
    const batch = contents.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(content => {
        const preMatch = expandedKeywords 
          ? preMatchKeyword(content, expandedKeywords) 
          : undefined;
        return analyzeContent(content, keyword, preMatch);
      })
    );
    results.push(...batchResults);
  }

  return results;
}
