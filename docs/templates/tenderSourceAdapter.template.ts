import type { SearchResult } from '../types.js';

/**
 * v1.4 新数据源 adapter 模板。
 * 使用方式：复制到 server/src/services/tenderSources.ts 或拆成独立模块后注册到 tenderSourceRegistry。
 */
export async function searchExampleTenderSource(query: string, limit = 20): Promise<SearchResult[]> {
  // 1. 请求列表接口 / HTML 页面
  // 2. 解析标题、详情链接、发布时间、摘要
  // 3. 过滤结果公告、候选人公示、合同公告、终止公告等低价值记录
  // 4. 构建稳定详情 URL
  // 5. 提取基础 tender metadata
  // 6. 返回 SearchResult[]

  void query;
  void limit;

  return [];
}
