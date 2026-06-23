import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity';

/**
 * index_classify 字段映射与树→扁平转换。
 *
 * 文档冻结（https://tushare.pro/wctapi/documents/181.md）：
 * 入参 level=L1|L2|L3 + src=SW2021（**非** market=SW），分 3 次拉取。
 * 输出字段：index_code, industry_name, parent_code, level, industry_code, is_pub, src
 *   - index_code：指数代码（如 801010），落库加 .SI 后缀作 ts_code 主键
 *   - industry_code：分类内部编码（如 110000），parent_code 引用它
 *   - parent_code：父级 industry_code（L1 为 '0'）
 *   - level：'L1' | 'L2' | 'L3'
 *   - is_pub：'1' | '0'（是否发布指数）
 *
 * 无 member_count 输出（文档表格列有但 API 输出参数表无），容错取 row.member_count 取不到则 null。
 *
 * 树→扁平：每行冗余存完整父链（l1_code/l1_name + l2_code/l2_name + l3_code/l3_name），
 * 便于按层级聚合查询。
 */

// index_classify 输出字段（文档冻结）；不传 fields 取默认全列更稳（src 默认不显示）
export const INDEX_CLASSIFY_FIELDS =
  'index_code,industry_name,parent_code,level,industry_code,is_pub';

export interface RawIndexClassifyRow {
  index_code?: unknown;
  industry_name?: unknown;
  parent_code?: unknown;
  level?: unknown;
  industry_code?: unknown;
  is_pub?: unknown;
  // 容错：部分账号可能返回 member_count（文档输出参数表未列，但表格有「成分股数」列）
  member_count?: unknown;
}

interface NormalizedNode {
  tsCode: string; // index_code + '.SI'
  name: string;
  industryCode: string;
  parentCode: string;
  level: 1 | 2 | 3;
  isPub: boolean | null;
  memberCount: number | null;
}

function normalizeLevel(raw: unknown): 1 | 2 | 3 | null {
  const s = String(raw ?? '').toUpperCase();
  if (s === 'L1' || s === '1') return 1;
  if (s === 'L2' || s === '2') return 2;
  if (s === 'L3' || s === '3') return 3;
  return null;
}

function normalizeRows(rows: RawIndexClassifyRow[], expectedLevel: 1 | 2 | 3): NormalizedNode[] {
  const out: NormalizedNode[] = [];
  for (const row of rows) {
    const indexCode = String(row.index_code ?? '').trim();
    const industryCode = String(row.industry_code ?? '').trim();
    if (!indexCode || !industryCode) continue;
    const level = normalizeLevel(row.level);
    if (level !== expectedLevel) continue;
    out.push({
      tsCode: `${indexCode}.SI`,
      name: String(row.industry_name ?? '').trim(),
      industryCode,
      parentCode: String(row.parent_code ?? '').trim(),
      level,
      isPub: normalizeIsPub(row.is_pub),
      memberCount: nullableFloat(row.member_count),
    });
  }
  return out;
}

function normalizeIsPub(v: unknown): boolean | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (s === '1' || s.toUpperCase() === 'TRUE') return true;
  if (s === '0' || s.toUpperCase() === 'FALSE') return false;
  return null;
}

function nullableFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把三级 index_classify 原始行转换为 sw_index_catalog 实体（冗余存父链）。
 *
 * - L1 节点：l1_*=自身，l2/l3=null
 * - L2 节点：parent_code 查 L1 industryCode → l1_*；l2_*=自身
 * - L3 节点：parent_code 查 L2 → l2_*；再查 L2.parent_code → l1_*
 *
 * parent_code 找不到父（数据残缺）时 warn 并跳过父字段（留 null），不丢节点。
 */
export function buildSwCatalogEntities(
  rawL1: RawIndexClassifyRow[],
  rawL2: RawIndexClassifyRow[],
  rawL3: RawIndexClassifyRow[],
): SwIndexCatalogEntity[] {
  const l1 = normalizeRows(rawL1, 1);
  const l2 = normalizeRows(rawL2, 2);
  const l3 = normalizeRows(rawL3, 3);

  const l1ByIndustryCode = new Map(l1.map((n) => [n.industryCode, n]));
  const l2ByIndustryCode = new Map(l2.map((n) => [n.industryCode, n]));

  const entities: SwIndexCatalogEntity[] = [];

  for (const node of l1) {
    entities.push(makeEntity(node, { l1: node }));
  }
  for (const node of l2) {
    const parent = node.parentCode ? l1ByIndustryCode.get(node.parentCode) : undefined;
    entities.push(makeEntity(node, { l1: parent ?? null, l2: node }));
  }
  for (const node of l3) {
    const parentL2 = node.parentCode ? l2ByIndustryCode.get(node.parentCode) : undefined;
    const parentL1 = parentL2?.parentCode ? l1ByIndustryCode.get(parentL2.parentCode) : undefined;
    entities.push(makeEntity(node, { l1: parentL1 ?? null, l2: parentL2 ?? null, l3: node }));
  }

  return entities;
}

function makeEntity(
  node: NormalizedNode,
  parents: { l1: NormalizedNode | null; l2?: NormalizedNode; l3?: NormalizedNode },
): SwIndexCatalogEntity {
  const e = new SwIndexCatalogEntity();
  e.tsCode = node.tsCode;
  e.name = node.name;
  e.level = node.level;
  e.l1Code = parents.l1?.tsCode ?? null;
  e.l1Name = parents.l1?.name ?? null;
  e.l2Code = parents.l2?.tsCode ?? null;
  e.l2Name = parents.l2?.name ?? null;
  e.l3Code = parents.l3?.tsCode ?? null;
  e.l3Name = parents.l3?.name ?? null;
  e.memberCount = node.memberCount;
  e.published = node.isPub;
  return e;
}
