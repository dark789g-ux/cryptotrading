/**
 * 大盘宽基候选噪声分类（纯函数）。
 *
 * 设计来源：docs/superpowers/specs/2026-06-23-market-index-dynamic-scope-design/05-validation-and-tasks.md §5.1
 *
 * 噪声规则只标注提醒，不强制处置——用户最终仍可勾选任何候选（「收敛集人工定稿」）。
 * 标签供前端「隐藏疑似噪声」开关过滤：delisted/cross_border/total_return 默认隐藏，
 * duplicate 标次挂牌但保留、small_cap 仅提醒不隐藏。
 */

/** 噪声标签。前端「隐藏疑似噪声」开关默认隐藏前三种。 */
export type NoiseTag =
  | 'delisted'      // ⚠ 已退市（exp_date 非空）
  | 'cross_border'  // ⚠ 跨境/外币/新三板
  | 'total_return'  // ⚠ 收益版（非价格版）
  | 'duplicate'     // 🔁 多挂牌次挂牌（.SH 优先主挂牌）
  | 'small_cap';    // ℹ 中小盘（仅提醒，不隐藏）

/** classifySingle 的单条输入。 */
export interface NoiseCandidate {
  /** TS 指数代码，如 '000300.SH'。duplicate 判定需要。可空（不参与 duplicate）。 */
  ts_code?: string;
  /** 指数简称。 */
  name: string;
  /** 终止日期（index_basic.exp_date），非空=已退市。 */
  exp_date?: string | null;
}

/** classifyNoise 批级输出：携带 ts_code 与该候选的标签集合。 */
export interface NoiseResult {
  ts_code: string;
  noise_tags: NoiseTag[];
}

// 跨境/外币/新三板关键词（name 子串匹配，区分大小写——USD/HKD 为大写）。
const CROSS_BORDER_KEYWORDS = ['USD', 'HKD', '港股', '美股', '三板', '东盟', '中韩'];

// 收益版关键词。
const TOTAL_RETURN_KEYWORDS = ['收益', '净收益'];

// 中小盘系列关键词（合法规模指数，仅提醒）。
const SMALL_CAP_KEYWORDS = ['上证小盘', '上证中盘', '国证', '巨潮'];

function containsAny(s: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => s.includes(kw));
}

/**
 * 对单条候选算标签（不含 duplicate——duplicate 是批级规则）。
 */
export function classifySingle(cand: NoiseCandidate): NoiseTag[] {
  const tags: NoiseTag[] = [];
  const name = cand.name ?? '';
  const expDate = cand.exp_date ?? '';

  if (expDate) {
    tags.push('delisted');
  }
  if (containsAny(name, CROSS_BORDER_KEYWORDS)) {
    tags.push('cross_border');
  }
  if (containsAny(name, TOTAL_RETURN_KEYWORDS) || name.includes('R')) {
    tags.push('total_return');
  }
  if (containsAny(name, SMALL_CAP_KEYWORDS)) {
    tags.push('small_cap');
  }

  return tags;
}

/** 提取 ts_code 的交易所后缀（如 '000300.SH' → 'SH'）。 */
function suffixOf(tsCode: string): string {
  const dotIdx = tsCode.indexOf('.');
  return dotIdx > 0 ? tsCode.slice(dotIdx + 1) : '';
}

/**
 * 对一批候选算完整标签（含 duplicate）。
 *
 * duplicate 规则：同名指数在不同交易所多次挂牌（如「沪深300」→ 000300.SH / 399300.SZ）。
 * 注：沪深300 在沪市代码是 000300、深市是 399300，前缀不同——故 duplicate 按 **name** 分组
 * （而非 ts_code 前缀），这与 spec 表述「000300.SH vs 399300.SZ」的实际语义一致。
 *
 * 主挂牌判定：组内含 .SH 则 .SH 主、其余 duplicate；无 .SH 则保持各组自身（不标）。
 *
 * @returns 与输入同序的结果数组，每项带 ts_code 与 noise_tags。
 */
export function classifyNoise(cands: NoiseCandidate[]): NoiseResult[] {
  // 按 name 分组，记录每组出现的交易所后缀集合（用于判断多挂牌）。
  const groupsByName = new Map<string, Set<string>>();
  for (const c of cands) {
    const tc = (c.ts_code ?? '').trim();
    const name = (c.name ?? '').trim();
    if (!tc || !name) continue;
    const suffix = suffixOf(tc);
    if (!suffix) continue;
    let set = groupsByName.get(name);
    if (!set) {
      set = new Set();
      groupsByName.set(name, set);
    }
    set.add(suffix);
  }

  return cands.map((c) => {
    const tc = (c.ts_code ?? '').trim();
    const tags = classifySingle(c);
    const name = (c.name ?? '').trim();
    const suffix = suffixOf(tc);
    const suffixes = name ? groupsByName.get(name) : undefined;
    // 多挂牌判定：同名有 ≥2 个不同交易所后缀，且当前后缀不是主挂牌（.SH）。
    if (suffix && suffixes && suffixes.size > 1 && suffix !== 'SH') {
      tags.push('duplicate');
    }
    return { ts_code: tc, noise_tags: tags };
  });
}
