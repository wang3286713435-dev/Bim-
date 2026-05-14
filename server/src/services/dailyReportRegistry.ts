export type DailySourceId = 'chinabim' | 'bimii' | 'bimbox' | 'shbimcenter' | 'fuzor' | 'buildingsmart';

export type DailySourceDefinition = {
  id: DailySourceId;
  name: string;
  homepage: string;
  listUrl: string;
  sourceType: 'portal' | 'official' | 'software' | 'standards';
};

export const DAILY_SOURCE_DEFINITIONS: DailySourceDefinition[] = [
  {
    id: 'chinabim',
    name: 'ChinaBIM',
    homepage: 'https://www.chinabim.com/',
    listUrl: 'https://www.chinabim.com/news',
    sourceType: 'portal',
  },
  {
    id: 'bimii',
    name: 'BIM建筑网',
    homepage: 'https://bimii.com/',
    listUrl: 'https://bimii.com/wp-json/wp/v2/posts?per_page=12&_fields=link,title,date,excerpt,categories,tags',
    sourceType: 'portal',
  },
  {
    id: 'bimbox',
    name: 'BIMBOX',
    homepage: 'https://bimbox.top/',
    listUrl: 'https://bimbox.top/topics/news',
    sourceType: 'portal',
  },
  {
    id: 'shbimcenter',
    name: '上海 BIM 推广中心',
    homepage: 'https://www.shbimcenter.org/',
    listUrl: 'https://www.shbimcenter.org/zhengcezhinan/',
    sourceType: 'official',
  },
  {
    id: 'fuzor',
    name: 'Fuzor 官网',
    homepage: 'https://www.bim4d.com.cn/',
    listUrl: 'https://www.bim4d.com.cn/support.html',
    sourceType: 'software',
  },
  {
    id: 'buildingsmart',
    name: 'buildingSMART',
    homepage: 'https://www.buildingsmart.org/',
    listUrl: 'https://www.buildingsmart.org/wp-json/wp/v2/posts?per_page=12&_fields=link,title,date,excerpt,categories,tags',
    sourceType: 'standards',
  },
];

export type DailyKeywordSeed = {
  label: string;
  slug: string;
  aliases: string[];
  category: string;
  sortOrder: number;
};

export const DEFAULT_DAILY_KEYWORDS: DailyKeywordSeed[] = [
  { label: 'BIM', slug: 'bim', aliases: ['建筑信息模型'], category: 'core', sortOrder: 10 },
  { label: '数字孪生', slug: 'digital-twin', aliases: ['Digital Twin'], category: 'trend', sortOrder: 20 },
  { label: 'CIM', slug: 'cim', aliases: ['城市信息模型', 'City Information Model'], category: 'trend', sortOrder: 30 },
  { label: 'Revit', slug: 'revit', aliases: ['Autodesk Revit'], category: 'software', sortOrder: 40 },
  { label: '智慧运维', slug: 'smart-operations', aliases: ['智能运维', '智能化运维'], category: 'operations', sortOrder: 50 },
  { label: 'OpenBIM', slug: 'openbim', aliases: ['openBIM'], category: 'standard', sortOrder: 60 },
  { label: 'IFC', slug: 'ifc', aliases: ['Industry Foundation Classes'], category: 'standard', sortOrder: 70 },
  { label: 'Autodesk Construction Cloud', slug: 'autodesk-construction-cloud', aliases: ['ACC', 'BIM 360', 'BIM360'], category: 'software', sortOrder: 80 },
  { label: '施工模拟', slug: 'construction-simulation', aliases: ['4D施工模拟'], category: 'delivery', sortOrder: 90 },
  { label: '4D', slug: '4d', aliases: ['4D施工'], category: 'delivery', sortOrder: 100 },
  { label: 'VR', slug: 'vr', aliases: ['虚拟现实'], category: 'software', sortOrder: 110 },
  { label: '参数化', slug: 'parametric', aliases: ['参数化设计'], category: 'design', sortOrder: 120 },
  { label: '机电', slug: 'mep', aliases: ['MEP'], category: 'discipline', sortOrder: 130 },
  { label: '装配式', slug: 'prefabrication', aliases: ['装配式建筑'], category: 'discipline', sortOrder: 140 },
];
