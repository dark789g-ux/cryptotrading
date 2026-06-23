import { buildSwCatalogEntities, RawIndexClassifyRow } from './sw-index-catalog-builder';

// 文档冻结样本（截取自 https://tushare.pro/wctapi/documents/181.md 数据示例）：
// 行业代码 | 指数代码 | 一级行业 | 二级行业 | 三级行业
// 110000 | 801010 | 农林牧渔 |        |
// 110100 | 801016 | 农林牧渔 | 种植业 |
// 110101 | 850111 | 农林牧渔 | 种植业 | 种子
const L1: RawIndexClassifyRow[] = [
  { index_code: '801010', industry_name: '农林牧渔', level: 'L1', industry_code: '110000', parent_code: '0', is_pub: '1' },
];
const L2: RawIndexClassifyRow[] = [
  { index_code: '801016', industry_name: '种植业', level: 'L2', industry_code: '110100', parent_code: '110000', is_pub: '1' },
];
const L3: RawIndexClassifyRow[] = [
  { index_code: '850111', industry_name: '种子', level: 'L3', industry_code: '110101', parent_code: '110100', is_pub: '1' },
  // 成分股<5 不发布
  { index_code: '850112', industry_name: '粮食种植', level: 'L3', industry_code: '110102', parent_code: '110100', is_pub: '0' },
];

describe('buildSwCatalogEntities', () => {
  it('L1 节点：l1_*=自身，l2/l3=null，ts_code 加 .SI 后缀', () => {
    const entities = buildSwCatalogEntities(L1, [], []);
    expect(entities).toHaveLength(1);
    const e = entities[0];
    expect(e.tsCode).toBe('801010.SI');
    expect(e.name).toBe('农林牧渔');
    expect(e.level).toBe(1);
    expect(e.l1Code).toBe('801010.SI');
    expect(e.l1Name).toBe('农林牧渔');
    expect(e.l2Code).toBeNull();
    expect(e.l2Name).toBeNull();
    expect(e.l3Code).toBeNull();
    expect(e.published).toBe(true);
  });

  it('L2 节点：parent_code 回溯 L1 填 l1_*，l2_*=自身', () => {
    const entities = buildSwCatalogEntities(L1, L2, []);
    const l2 = entities.find((e) => e.level === 2);
    expect(l2).toBeDefined();
    expect(l2!.tsCode).toBe('801016.SI');
    expect(l2!.name).toBe('种植业');
    expect(l2!.l1Code).toBe('801010.SI');
    expect(l2!.l1Name).toBe('农林牧渔');
    expect(l2!.l2Code).toBe('801016.SI');
    expect(l2!.l2Name).toBe('种植业');
    expect(l2!.l3Code).toBeNull();
  });

  it('L3 节点：parent_code 回溯 L2 → 再回溯 L1，三级父链全填', () => {
    const entities = buildSwCatalogEntities(L1, L2, L3);
    const l3 = entities.find((e) => e.tsCode === '850111.SI');
    expect(l3).toBeDefined();
    expect(l3!.level).toBe(3);
    expect(l3!.l1Code).toBe('801010.SI');
    expect(l3!.l1Name).toBe('农林牧渔');
    expect(l3!.l2Code).toBe('801016.SI');
    expect(l3!.l2Name).toBe('种植业');
    expect(l3!.l3Code).toBe('850111.SI');
    expect(l3!.l3Name).toBe('种子');
  });

  it('is_pub=0 → published=false（不发布的指数仍保留节点）', () => {
    const entities = buildSwCatalogEntities(L1, L2, L3);
    const unpub = entities.find((e) => e.tsCode === '850112.SI');
    expect(unpub).toBeDefined();
    expect(unpub!.published).toBe(false);
  });

  it('三级合计行数 = L1 + L2 + L3', () => {
    const entities = buildSwCatalogEntities(L1, L2, L3);
    expect(entities).toHaveLength(L1.length + L2.length + L3.length);
  });

  it('L2 parent_code 找不到父 L1（数据残缺）：节点保留，l1_*=null', () => {
    const orphanL2: RawIndexClassifyRow[] = [
      { index_code: '801999', industry_name: '孤儿二级', level: 'L2', industry_code: '999999', parent_code: '888888', is_pub: '1' },
    ];
    const entities = buildSwCatalogEntities([], orphanL2, []);
    const e = entities.find((x) => x.tsCode === '801999.SI');
    expect(e).toBeDefined();
    expect(e!.l1Code).toBeNull();
    expect(e!.l2Code).toBe('801999.SI');
  });

  it('缺失 industry_code 的脏行被跳过', () => {
    const dirty: RawIndexClassifyRow[] = [
      { index_code: '801010', industry_name: '无分类码', level: 'L1', industry_code: '', parent_code: '0', is_pub: '1' },
      { index_code: '', industry_name: '无指数码', level: 'L1', industry_code: '110000', parent_code: '0', is_pub: '1' },
    ];
    const entities = buildSwCatalogEntities(dirty, [], []);
    expect(entities).toHaveLength(0);
  });
});
