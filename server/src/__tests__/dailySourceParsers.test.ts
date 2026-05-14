import { describe, expect, it } from 'vitest';
import {
  parseBimboxTopicHtml,
  parseChinaBimListResponse,
  parseFuzorSupportHtml,
  parseShbimCenterListHtml,
  parseWordPressPosts
} from '../services/dailySourceParsers.js';

describe('parseBimboxTopicHtml', () => {
  it('extracts title, url, excerpt, and date from BIMBOX cards', () => {
    const html = `
      <article class="grid-item">
        <h2 class="entry-title"><a href="https://bimbox.top/13483.html">从BIM草莽时代到数字秩序时代</a></h2>
        <div class="entry-excerpt"><p>星光不问赶路者，岁月不负有心人</p></div>
        <a class="time" href="https://bimbox.top/13483.html"><span class="count">2024-10-24</span></a>
      </article>
    `;
    const rows = parseBimboxTopicHtml(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '从BIM草莽时代到数字秩序时代',
      url: 'https://bimbox.top/13483.html',
      excerpt: '星光不问赶路者，岁月不负有心人'
    });
    expect(rows[0].publishedAt?.toISOString()).toContain('2024-10-24');
  });
});

describe('parseShbimCenterListHtml', () => {
  it('extracts policy/case articles from Shanghai BIM center lists', () => {
    const html = `
      <a href="/shanghaizhengce/20213305.html">关于发布《上海市建筑信息模型技术应用指南（2025版）》的通知 [2025-05-15]</a>
      <a href="/anlizhanshi/20212881.html">【试点案例】上海市第六人民医院科研综合楼BIM技术应用 2021-05-24 上海市第六人民医院全院用地面积86168㎡。</a>
    `;
    const rows = parseShbimCenterListHtml(html, 'https://www.shbimcenter.org/zhengcezhinan/');
    expect(rows).toHaveLength(2);
    expect(rows[0].url).toBe('https://www.shbimcenter.org/shanghaizhengce/20213305.html');
    expect(rows[0].publishedAt?.toISOString()).toContain('2025-05-15');
  });
});

describe('parseFuzorSupportHtml', () => {
  it('extracts title, summary, and date from Fuzor support lists', () => {
    const html = `
      <div class="item">
        <div class="time">2023.06.25</div>
        <a class="title" href="rumen/fuzor-hvig.html" target="_blank" title="Fuzor怎么控制人物">Fuzor怎么控制人物</a>
        <div class="desc">Fuzor新手教程，快速上手软件</div>
      </div>
    `;
    const rows = parseFuzorSupportHtml(html, 'https://www.bim4d.com.cn/support.html');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Fuzor怎么控制人物',
      url: 'https://www.bim4d.com.cn/rumen/fuzor-hvig.html',
      excerpt: 'Fuzor新手教程，快速上手软件'
    });
  });
});

describe('parseChinaBimListResponse', () => {
  it('extracts article rows from ChinaBIM API payloads', () => {
    const rows = parseChinaBimListResponse({
      code: 200,
      data: {
        list: [
          {
            id: '812636305308520389',
            title: '第十六期BIM大讲堂成功举办',
            digest: '春和景明，万物焕新。',
            releaseDate: '2026-04-11'
          }
        ]
      }
    }, 'https://www.chinabim.com');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '第十六期BIM大讲堂成功举办',
      url: 'https://www.chinabim.com/en/news/812636305308520389',
      excerpt: '春和景明，万物焕新。'
    });
  });
});

describe('parseWordPressPosts', () => {
  it('extracts rows from WordPress post JSON', () => {
    const rows = parseWordPressPosts([
      {
        date: '2026-04-30T10:56:12',
        link: 'https://www.buildingsmart.org/example',
        title: { rendered: 'buildingSMART International Appoints Aidan Mercer as Managing Director' },
        excerpt: { rendered: '<p>London, U.K. April 30th, 2026...</p>' }
      }
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'buildingSMART International Appoints Aidan Mercer as Managing Director',
      url: 'https://www.buildingsmart.org/example',
      excerpt: 'London, U.K. April 30th, 2026...'
    });
  });
});
