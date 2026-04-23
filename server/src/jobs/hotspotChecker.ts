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
import {
  buildSearchQueries,
  getEnabledTenderSources,
  getTenderSourcePriority,
  searchTenderSourceAcrossQueries
} from '../services/tenderSourceRegistry.js';
import type { SearchResult } from '../types.js';

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

  // 获取所有激活的关键词
  const keywords = await prisma.keyword.findMany({
    where: { isActive: true }
  });

  if (keywords.length === 0) {
    console.log('No active keywords to monitor');
    return;
  }

  console.log(`Checking ${keywords.length} keywords...`);

  let newHotspotsCount = 0;

  for (const keyword of keywords) {
    console.log(`\n📎 Checking keyword: "${keyword.text}"`);
    let runId: string | null = null;

    try {
      const runtimeConfig = await getRuntimeConfig();
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
              ok: result.value.rows.length > 0,
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

      // 处理结果：招采来源共享配额，避免单次任务过慢
      let processed = 0;
      let filtered = 0;

      for (const item of sortedResults) {
        if (processed >= runtimeConfig.resultsPerKeyword) break;
        try {
          if (shouldDropLowValueResult(item, runtimeConfig)) {
            filtered++;
            console.log(`  ⏭ Rule filtered: ${item.title.slice(0, 30)}...`);
            continue;
          }

          // 检查是否已存在
          const existing = await prisma.hotspot.findFirst({
            where: {
              url: item.url,
              source: item.source
            }
          });

          if (existing) {
            continue;
          }

          const enrichedItem = shouldEnrichWithFirecrawl(item)
            ? await enrichResultWithFirecrawl(item)
            : item;
          const tenderDetail = extractTenderDetailFields(enrichedItem);

          // AI 分析（传入关键词和预匹配结果）
          const fullText = enrichedItem.title + '\n' + enrichedItem.content;
          const preMatch = preMatchKeyword(fullText, expandedKeywords);
          const analysis = await analyzeContent(fullText, keyword.text, preMatch);

          // 只保存真实且相关的招采公告
          if (!analysis.isReal) {
            console.log(`  ❌ Filtered fake/spam: ${item.title.slice(0, 30)}...`);
            filtered++;
            continue;
          }

          // 相关性阈值：50 分以下过滤
          if (analysis.relevance < runtimeConfig.minRelevanceScore) {
            console.log(`  ⏭ Low relevance (${analysis.relevance}): ${item.title.slice(0, 30)}...`);
            filtered++;
            continue;
          }

          // 额外规则：关键词未被提及且相关性不足 65 → 过滤
          if (!analysis.keywordMentioned && analysis.relevance < runtimeConfig.strictKeywordMentionScore) {
            console.log(`  ⏭ Keyword not mentioned & relevance < ${runtimeConfig.strictKeywordMentionScore} (${analysis.relevance}): ${item.title.slice(0, 30)}...`);
            filtered++;
            continue;
          }

          // 保存招采公告
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
              tenderUnit: tenderDetail.unit || null,
              tenderBudgetWan: tenderDetail.budgetWan ?? null,
              tenderDeadline: tenderDetail.deadline || null,
              tenderNoticeType: item.tender?.noticeType || null,
              tenderPlatform: item.tender?.platform || null,
              tenderProjectCode: tenderDetail.projectCode || null,
              tenderContact: tenderDetail.contact || null,
              tenderPhone: tenderDetail.phone || null,
              tenderEmail: tenderDetail.email || null,
              tenderBidOpenTime: tenderDetail.bidOpenTime || null,
              tenderDocDeadline: tenderDetail.docDeadline || null,
              tenderServiceScope: tenderDetail.serviceScope || null,
              tenderQualification: tenderDetail.qualification || null,
              tenderAddress: tenderDetail.address || null,
              tenderDetailSource: tenderDetail.detailSource || null,
              tenderDetailExtractedAt: tenderDetail.detailExtractedAt || null,
              keywordId: keyword.id
            },
            include: {
              keyword: true
            }
          });

          newHotspotsCount++;
          processed++;
          console.log(`  ✅ New hotspot [${item.source}]: ${hotspot.title.slice(0, 40)}... (${analysis.importance})`);
          enqueueHotspotDetailEnrichment(hotspot.id);

          // 创建通知
          await prisma.notification.create({
            data: {
              type: 'hotspot',
              title: `发现新招采公告: ${hotspot.title.slice(0, 50)}`,
              content: analysis.summary || hotspot.content.slice(0, 100),
              hotspotId: hotspot.id
            }
          });

          // WebSocket 通知
          io.to(`keyword:${keyword.text}`).emit('hotspot:new', hotspot);
          io.emit('notification', {
            type: 'hotspot',
            title: '发现新招采公告',
            content: hotspot.title,
            hotspotId: hotspot.id,
            importance: hotspot.importance
          });

          // 邮件通知（仅对高重要级别）
          if (['high', 'urgent'].includes(analysis.importance)) {
            await sendHotspotEmail(hotspot);
          }

          // 飞书通知：群机器人卡片 + 可选多维表格写入
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

        } catch (error) {
          console.error(`  Error processing result:`, error);
          filtered++;
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
