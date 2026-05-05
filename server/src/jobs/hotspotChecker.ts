import { Server } from 'socket.io';
import { prisma } from '../db.js';
import { deduplicateResults } from '../services/search.js';
import { enrichResultWithFirecrawl, shouldEnrichWithFirecrawl } from '../services/firecrawl.js';
import { analyzeContent, expandKeyword, preMatchKeyword } from '../services/ai.js';
import { extractTenderDetailFields } from '../services/tenderDetailExtractor.js';
import { sendHotspotEmail } from '../services/email.js';
import { notifyFeishu } from '../services/feishu.js';
import { createCrawlRun, logSourceProbe, updateCrawlRun } from '../services/crawlRunLogger.js';
import { getRuntimeConfig } from '../services/runtimeConfig.js';
import { enqueueHotspotDetailEnrichment } from '../services/tenderDetailEnrichment.js';
import { recordAIAnalysisLog } from '../services/aiAnalysisLogger.js';
import { evaluateKeywordCooldown } from '../services/keywordCooldown.js';
import {
  buildSearchQueries,
  getEnabledTenderSources,
  getTenderSourcePriority,
  searchTenderSourceAcrossQueries
} from '../services/tenderSourceRegistry.js';
import type { SearchResult } from '../types.js';

const AI_ANALYSIS_CONCURRENCY = Math.min(
  4,
  Math.max(1, Number.parseInt(process.env.TENDER_AI_CONCURRENCY || '2', 10) || 2)
);

function filterByFreshness(results: SearchResult[], maxAgeDays: number): SearchResult[] {
  const maxAgeHours = maxAgeDays * 24;
  const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000);
  return results.filter(item => {
    // 没有发布时间的，暂时保留（搜索引擎结果通常没有时间）
    if (!item.publishedAt) return true;
    return item.publishedAt >= cutoff;
  });
}

function shouldDropLowValueResult(item: SearchResult, config: Awaited<ReturnType<typeof getRuntimeConfig>>): boolean {
  const text = `${item.title}\n${item.content}`.toLowerCase();
  const hasInclude = config.lowValueIncludeKeywords.some(keyword => text.includes(keyword.toLowerCase()));
  const hasExclude = config.lowValueExcludeKeywords.some(keyword => text.includes(keyword.toLowerCase()));
  return hasExclude && !hasInclude;
}

// 按招采来源优先级排序。当前产品只保留政府/招采网站，不再跑泛热点源。
function prioritizeResults(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => {
    return getTenderSourcePriority(a.source) - getTenderSourcePriority(b.source);
  });
}

export async function runHotspotCheck(io: Server, triggerType: 'manual' | 'scheduled' = 'manual'): Promise<void> {
  console.log('🔍 Starting hotspot check...');
  const runtimeConfig = await getRuntimeConfig();

  // 获取所有激活的关键词
  const keywords = await prisma.keyword.findMany({
    where: { isActive: true }
  });

  if (keywords.length === 0) {
    console.log('No active keywords to monitor');
    return;
  }

  let runnableKeywords = keywords;
  if (triggerType === 'scheduled' && keywords.length > 0) {
    const lookbackStartedAt = new Date(Date.now() - runtimeConfig.keywordCooldownLookbackDays * 24 * 60 * 60 * 1000);
    const recentRuns = await prisma.crawlRun.findMany({
      where: {
        triggerType: 'scheduled',
        status: 'completed',
        keywordId: { in: keywords.map((keyword) => keyword.id) },
        startedAt: { gte: lookbackStartedAt }
      },
      select: {
        keywordId: true,
        totalSaved: true,
        startedAt: true,
        completedAt: true
      },
      orderBy: { startedAt: 'desc' }
    });

    const runsByKeyword = new Map<string, typeof recentRuns>();
    for (const run of recentRuns) {
      if (!run.keywordId) continue;
      const list = runsByKeyword.get(run.keywordId) || [];
      list.push(run);
      runsByKeyword.set(run.keywordId, list);
    }

    const skippedKeywords: Array<{ text: string; consecutiveZeroSaveRuns: number; cooldownRemainingMs: number }> = [];
    runnableKeywords = keywords.filter((keyword) => {
      const decision = evaluateKeywordCooldown(
        runsByKeyword.get(keyword.id) || [],
        {
          zeroSaveThreshold: runtimeConfig.keywordCooldownZeroSaveThreshold,
          cooldownHours: runtimeConfig.keywordCooldownHours,
          lookbackDays: runtimeConfig.keywordCooldownLookbackDays
        }
      );

      if (!decision.shouldSkip) return true;

      skippedKeywords.push({
        text: keyword.text,
        consecutiveZeroSaveRuns: decision.consecutiveZeroSaveRuns,
        cooldownRemainingMs: decision.cooldownRemainingMs,
      });
      return false;
    });

    if (skippedKeywords.length > 0) {
      console.log(`⏸ Keyword cooldown active: skipped ${skippedKeywords.length}/${keywords.length} keywords`);
      for (const item of skippedKeywords.slice(0, 12)) {
        const remainingHours = Math.max(1, Math.ceil(item.cooldownRemainingMs / (60 * 60 * 1000)));
        console.log(`  · ${item.text}: ${item.consecutiveZeroSaveRuns} consecutive zero-save runs, retry in ~${remainingHours}h`);
      }
      if (skippedKeywords.length > 12) {
        console.log(`  · ...and ${skippedKeywords.length - 12} more`);
      }
    }
  }

  if (runnableKeywords.length === 0) {
    console.log('All active keywords are currently cooling down; skipping this scheduled run');
    return;
  }

  console.log(`Checking ${runnableKeywords.length}/${keywords.length} keywords...`);

  let newHotspotsCount = 0;

  for (const keyword of runnableKeywords) {
    console.log(`\n📎 Checking keyword: "${keyword.text}"`);
    let runId: string | null = null;

    try {
      // 第一步：Query Expansion（查询扩展）
      console.log(`  🔍 Expanding keyword "${keyword.text}"...`);
      const expandedKeywords = await expandKeyword(keyword.text);
      console.log(`  📋 Expanded to ${expandedKeywords.length} variants: ${expandedKeywords.slice(0, 5).join(', ')}${expandedKeywords.length > 5 ? '...' : ''}`);

      const searchQueries = await buildSearchQueries(keyword.text, expandedKeywords);
      console.log(`  🧭 Source search queries: ${searchQueries.join(', ')}`);
      const run = await createCrawlRun({
        triggerType,
        keywordId: keyword.id,
        keywordText: keyword.text,
        searchQueries
      });
      runId = run.id;

      // 第二步：只从政府/招采来源获取数据。来源注册在 tenderSourceRegistry 中，后续新增站点只加 adapter。
      const enabledSources = await getEnabledTenderSources();
      const sourceResults = await Promise.allSettled(enabledSources.map(async source => {
        const startedAt = Date.now();
        const rows = await searchTenderSourceAcrossQueries(source, searchQueries, runtimeConfig.sourceResultLimit);
        return {
          source,
          rows,
          elapsedMs: Date.now() - startedAt
        };
      }));
      const allResults: SearchResult[] = [];

      for (let i = 0; i < enabledSources.length; i += 1) {
        const source = enabledSources[i];
        const result = sourceResults[i];
        if (result.status === 'fulfilled') {
          allResults.push(...result.value.rows);
          console.log(`  ${source.id}: ${result.value.rows.length} results`);
          if (runId) {
            await logSourceProbe(runId, {
              sourceId: source.id,
              sourceName: source.name,
              queryText: searchQueries.join(', '),
              enabled: true,
              ok: true,
              resultCount: result.value.rows.length,
              elapsedMs: result.value.elapsedMs,
              sampleTitle: result.value.rows[0]?.title,
              sampleUrl: result.value.rows[0]?.url
            });
          }
        } else {
          console.log(`  ${source.id}: failed - ${result.reason}`);
          if (runId) {
            await logSourceProbe(runId, {
              sourceId: source.id,
              sourceName: source.name,
              queryText: searchQueries.join(', '),
              enabled: true,
              ok: false,
              resultCount: 0,
              elapsedMs: 0,
              errorMessage: result.reason instanceof Error ? result.reason.message : String(result.reason)
            });
          }
        }
      }

      // 去重 → 新鲜度过滤 → 按来源优先级排序
      const uniqueResults = deduplicateResults(allResults);
      const freshResults = filterByFreshness(uniqueResults, runtimeConfig.maxAgeDays);
      const sortedResults = prioritizeResults(freshResults);
      console.log(`  Total: ${allResults.length} raw → ${uniqueResults.length} unique → ${freshResults.length} fresh (within ${runtimeConfig.maxAgeDays}d)`);

      // 处理结果：招采来源共享配额，避免单次任务过慢；AI 分析允许有限并行
      let processed = 0;
      let filtered = 0;

      async function processResult(item: SearchResult): Promise<'saved' | 'filtered' | 'skipped'> {
        try {
          if (shouldDropLowValueResult(item, runtimeConfig)) {
            console.log(`  ⏭ Rule filtered: ${item.title.slice(0, 30)}...`);
            return 'filtered';
          }

          const existing = await prisma.hotspot.findFirst({
            where: {
              url: item.url,
              source: item.source
            }
          });

          if (existing) {
            return 'skipped';
          }

          const enrichedItem = shouldEnrichWithFirecrawl(item)
            ? await enrichResultWithFirecrawl(item)
            : item;
          const tenderDetail = extractTenderDetailFields(enrichedItem);

          const fullText = enrichedItem.title + '\n' + enrichedItem.content;
          const preMatch = preMatchKeyword(fullText, expandedKeywords);
          const analysis = await analyzeContent(fullText, keyword.text, preMatch);

          if (!analysis.isReal) {
            await recordAIAnalysisLog({
              runId,
              source: item.source,
              keywordText: keyword.text,
              title: item.title,
              url: item.url,
              analysis
            });
            console.log(`  ❌ Filtered fake/spam: ${item.title.slice(0, 30)}...`);
            return 'filtered';
          }

          if (analysis.relevance < runtimeConfig.minRelevanceScore) {
            await recordAIAnalysisLog({
              runId,
              source: item.source,
              keywordText: keyword.text,
              title: item.title,
              url: item.url,
              analysis
            });
            console.log(`  ⏭ Low relevance (${analysis.relevance}): ${item.title.slice(0, 30)}...`);
            return 'filtered';
          }

          if (!analysis.keywordMentioned && analysis.relevance < runtimeConfig.strictKeywordMentionScore) {
            await recordAIAnalysisLog({
              runId,
              source: item.source,
              keywordText: keyword.text,
              title: item.title,
              url: item.url,
              analysis
            });
            console.log(`  ⏭ Keyword not mentioned & relevance < ${runtimeConfig.strictKeywordMentionScore} (${analysis.relevance}): ${item.title.slice(0, 30)}...`);
            return 'filtered';
          }

          const hotspot = await prisma.hotspot.create({
            data: {
              title: item.title,
              content: enrichedItem.content,
              url: item.url,
              source: item.source,
              sourceId: item.sourceId != null ? String(item.sourceId) : null,
              isReal: analysis.isReal,
              relevance: analysis.relevance,
              relevanceReason: analysis.relevanceReason || null,
              keywordMentioned: analysis.keywordMentioned ?? null,
              importance: analysis.importance,
              summary: analysis.summary,
              viewCount: item.viewCount || null,
              likeCount: item.likeCount || null,
              retweetCount: item.retweetCount || null,
              replyCount: item.replyCount || null,
              commentCount: item.commentCount || null,
              quoteCount: item.quoteCount || null,
              danmakuCount: item.danmakuCount || null,
              authorName: item.author?.name || null,
              authorUsername: item.author?.username || null,
              authorAvatar: item.author?.avatar || null,
              authorFollowers: item.author?.followers || null,
              authorVerified: item.author?.verified ?? null,
              publishedAt: item.publishedAt || null,
              tenderType: item.tender?.type || null,
              tenderRegion: item.tender?.region || null,
              tenderCity: item.tender?.city || null,
              tenderUnit: tenderDetail.unit || item.tender?.unit || null,
              tenderBudgetWan: tenderDetail.budgetWan ?? item.tender?.budgetWan ?? null,
              tenderDeadline: tenderDetail.deadline || item.tender?.deadline || null,
              tenderNoticeType: item.tender?.noticeType || null,
              tenderPlatform: item.tender?.platform || null,
              tenderProjectCode: tenderDetail.projectCode || item.tender?.projectCode || null,
              tenderContact: tenderDetail.contact || item.tender?.contact || null,
              tenderPhone: tenderDetail.phone || item.tender?.phone || null,
              tenderEmail: tenderDetail.email || item.tender?.email || null,
              tenderBidOpenTime: tenderDetail.bidOpenTime || item.tender?.bidOpenTime || null,
              tenderDocDeadline: tenderDetail.docDeadline || item.tender?.docDeadline || null,
              tenderServiceScope: tenderDetail.serviceScope || item.tender?.serviceScope || null,
              tenderQualification: tenderDetail.qualification || item.tender?.qualification || null,
              tenderAddress: tenderDetail.address || item.tender?.address || null,
              tenderDetailSource: tenderDetail.detailSource || item.tender?.detailSource || null,
              tenderDetailExtractedAt: tenderDetail.detailExtractedAt || item.tender?.detailExtractedAt || null,
              keywordId: keyword.id
            },
            include: {
              keyword: true
            }
          });

          console.log(`  ✅ New hotspot [${item.source}]: ${hotspot.title.slice(0, 40)}... (${analysis.importance})`);
          await recordAIAnalysisLog({
            runId,
            hotspotId: hotspot.id,
            source: item.source,
            keywordText: keyword.text,
            title: item.title,
            url: item.url,
            analysis
          });
          enqueueHotspotDetailEnrichment(hotspot.id);

          await prisma.notification.create({
            data: {
              type: 'hotspot',
              title: `发现新招采公告: ${hotspot.title.slice(0, 50)}`,
              content: analysis.summary || hotspot.content.slice(0, 100),
              hotspotId: hotspot.id
            }
          });

          io.to(`keyword:${keyword.text}`).emit('hotspot:new', hotspot);
          io.emit('notification', {
            type: 'hotspot',
            title: '发现新招采公告',
            content: hotspot.title,
            hotspotId: hotspot.id,
            importance: hotspot.importance
          });

          if (['high', 'urgent'].includes(analysis.importance)) {
            await sendHotspotEmail(hotspot);
          }

          await notifyFeishu({
            ...hotspot,
            publishedAt: hotspot.publishedAt,
            tenderType: hotspot.tenderType,
            tenderRegion: hotspot.tenderRegion,
            tenderCity: hotspot.tenderCity,
            tenderUnit: hotspot.tenderUnit,
            tenderBudgetWan: hotspot.tenderBudgetWan,
            tenderDeadline: hotspot.tenderDeadline,
            tenderBidOpenTime: hotspot.tenderBidOpenTime,
            tenderDocDeadline: hotspot.tenderDocDeadline,
            tenderProjectCode: hotspot.tenderProjectCode,
            tenderContact: hotspot.tenderContact,
            tenderPhone: hotspot.tenderPhone,
            tenderQualification: hotspot.tenderQualification,
            tenderServiceScope: hotspot.tenderServiceScope
          });

          return 'saved';
        } catch (error) {
          console.error(`  Error processing result:`, error);
          return 'filtered';
        }
      }

      for (let index = 0; index < sortedResults.length && processed < runtimeConfig.resultsPerKeyword; index += AI_ANALYSIS_CONCURRENCY) {
        const remainingQuota = runtimeConfig.resultsPerKeyword - processed;
        const chunk = sortedResults.slice(index, index + Math.min(AI_ANALYSIS_CONCURRENCY, remainingQuota));
        const outcomes = await Promise.allSettled(chunk.map(processResult));

        for (const outcome of outcomes) {
          if (outcome.status !== 'fulfilled') {
            filtered++;
            continue;
          }

          if (outcome.value === 'saved') {
            processed++;
            newHotspotsCount++;
          } else if (outcome.value === 'filtered') {
            filtered++;
          }
        }
      }

      if (runId) {
        await updateCrawlRun(runId, {
          status: 'completed',
          totalRaw: allResults.length,
          totalUnique: uniqueResults.length,
          totalFresh: freshResults.length,
          totalSaved: processed,
          totalFiltered: filtered,
          completed: true
        });
      }

      // 避免过快请求
      await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
      console.error(`Error checking keyword "${keyword.text}":`, error);
      if (runId) {
        await updateCrawlRun(runId, {
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
          completed: true
        });
      }
    }
  }

  console.log(`\n✨ Hotspot check completed. Found ${newHotspotsCount} new hotspots.`);
}
