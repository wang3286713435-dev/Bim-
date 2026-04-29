import type { AIAnalysis } from '../types.js';
import { generateStructuredJson, getOpenClawAnalysisOptions } from './llmProvider.js';

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

function getAIProviderName(): NonNullable<AIAnalysis['telemetry']>['provider'] {
  if (process.env.AI_PROVIDER === 'openclaw') return 'openclaw';
  if (hasUsableOpenRouterKey()) return 'openrouter';
  return 'rule';
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      ], {
        temperature: 0.2,
        maxTokens: 300,
        openclaw: getOpenClawAnalysisOptions({ sessionPrefix: 'expand' })
      });

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
    ? `命中词：${preMatchResult.matchedTerms.slice(0, 8).join('、')}` 
    : `未直接命中关键词：${keyword}`;

  return `你是 BIM 投标机会分类器。根据公告判断是否值得跟进。${matchHint}
只返回 JSON：
{"isReal":boolean,"relevance":0-100,"relevanceReason":"30字内理由","keywordMentioned":boolean,"importance":"low|medium|high|urgent","summary":"80字内投标要点"}
规则：结果/候选/合同/终止/坏页 isReal=false；90+立即跟进，75-89商机初筛，60-74补字段，40-59观察；summary 写单位/预算/截止/BIM范围/建议动作，缺失写待补齐。`;
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

function cleanContentForAI(content: string): string {
  const normalized = content
    .replace(/\r/g, '\n')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[[^\]]+]\([^)]+\)/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/---+\s*Detail Enrichment[\s\S]*$/i, ' ')
    .replace(/---+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const usefulLines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => line.length >= 4)
    .filter(line => !/^(首页|当前位置|返回列表|点击查看|附件下载|打印|关闭窗口|分享|收藏)$/.test(line))
    .filter(line => !/^https?:\/\//i.test(line));

  const priorityLines: string[] = [];
  const secondaryLines: string[] = [];

  for (const line of usefulLines) {
    if (/(BIM|建筑信息模型|智慧建造|项目名称|项目概况|项目编号|采购单位|招标人|招标单位|采购人|预算|控制价|最高限价|联系人|联系电话|联系方式|截止|开标|投标|服务范围|采购需求|资格要求|资质要求|地区|地点|地址)/i.test(line)) {
      priorityLines.push(line);
    } else if (line.length <= 120) {
      secondaryLines.push(line);
    }
  }

  const merged = [...new Set([...priorityLines, ...secondaryLines])];
  return merged.join('\n').slice(0, 1600);
}

function buildAIInputVariants(content: string): string[] {
  const cleaned = cleanContentForAI(content);
  if (!cleaned) {
    return [content.slice(0, 1200)];
  }

  const variants = [
    cleaned.slice(0, 1400),
    cleaned.slice(0, 900)
  ].filter(Boolean);

  return [...new Set(variants)];
}

export async function analyzeContent(content: string, keyword: string, preMatchResult?: { matched: boolean; matchedTerms: string[] }): Promise<AIAnalysis> {
  const startedAt = Date.now();
  const provider = getAIProviderName();
  // 默认预匹配结果
  const matchResult = preMatchResult ?? { matched: false, matchedTerms: [] };

  if (!hasUsableOpenRouterKey() && process.env.AI_PROVIDER !== 'openclaw') {
    console.warn('OpenRouter API key not configured, using fallback analysis');
    return {
      ...buildRuleBasedTenderAnalysis(content, matchResult, '未配置 AI 服务，使用规则投标分析'),
      telemetry: {
        provider: 'rule',
        status: 'fallback',
        fallbackUsed: true,
        attemptCount: 0,
        elapsedMs: Date.now() - startedAt,
        errorMessage: 'AI provider not configured'
      }
    };
  }

  let attemptCount = 0;

  try {
    const prompt = buildAnalysisPrompt(keyword, matchResult);
    const variants = buildAIInputVariants(content);
    let lastError: unknown;

    for (let i = 0; i < variants.length; i++) {
      try {
        attemptCount += 1;
        const parsed = await generateStructuredJson<AIAnalysis>([
            {
              role: 'system',
              content: prompt
            },
            {
              role: 'user',
              content: variants[i]
            }
          ], {
            temperature: 0.2,
            maxTokens: 500,
            openclaw: getOpenClawAnalysisOptions({ sessionPrefix: 'analysis' })
          });

        const normalizedReason = String(parsed.relevanceReason || '').trim();
        const normalizedSummary = String(parsed.summary || '').trim();
        const normalizedRelevance = Number(parsed.relevance);
        if (!normalizedReason || !normalizedSummary || !Number.isFinite(normalizedRelevance)) {
          throw new Error('AI provider returned an incomplete analysis payload');
        }

        return {
          isReal: Boolean(parsed.isReal),
          relevance: Math.min(100, Math.max(0, normalizedRelevance || 0)),
          relevanceReason: normalizedReason.slice(0, 200),
          keywordMentioned: Boolean(parsed.keywordMentioned),
          importance: ['low', 'medium', 'high', 'urgent'].includes(parsed.importance)
            ? parsed.importance
            : 'low',
          summary: normalizedSummary.slice(0, 150),
          telemetry: {
            provider,
            status: 'success',
            fallbackUsed: false,
            attemptCount,
            elapsedMs: Date.now() - startedAt
          }
        };
      } catch (error) {
        lastError = error;
        console.warn(`AI analysis attempt ${i + 1}/${variants.length} failed, retrying with a shorter payload`);
      }
    }

    throw lastError;
  } catch (error) {
    console.error('AI analysis failed:', error);
    return {
      ...buildRuleBasedTenderAnalysis(content, matchResult, 'AI 分析超时或失败，使用规则投标分析'),
      telemetry: {
        provider,
        status: 'fallback',
        fallbackUsed: true,
        attemptCount,
        elapsedMs: Date.now() - startedAt,
        errorMessage: errorToMessage(error)
      }
    };
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
