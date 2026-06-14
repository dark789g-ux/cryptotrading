/**
 * portfolio-sim.factor-registry.ts
 *
 * 多因子排序注册表（白名单）+ rank 配置纯函数（纯逻辑，不依赖 DB / NestJS）。
 *
 * 职责（spec 02 §为什么要注册表）：
 *   ① loader 的 JOIN / 列来源单一真相——前端只发因子 KEY，后端用本注册表把 KEY 翻译成
 *      「来源表 + 列 / 现算表达式」，绝不把前端字符串拼进 SQL（database-sql.md：禁拼前端字段名）。
 *   ② service 白名单：VALID_RANK_FACTOR_KEYS 从注册表 keys 自动派生，不再手维护。
 *   ③ 前端选项与提示来源（label / histAvailable / defaultDir）。
 *
 * 所有 table / column / schema 是注册表里写死的常量字符串（代码字面量），不接受任何外部输入。
 * import 方向：本文件 → portfolio-sim.types（取 RankFactorKey/RankFactor/PortfolioSimSource）；
 * types 不得反向 import 本文件（避免循环依赖）。
 */

import {
  RankFactor,
  RankFactorKey,
  PortfolioSimSource,
} from './portfolio-sim.types';

// ─────────────────────────────────────────────────────────────────────────────
// 注册表条目结构（spec 02 §注册表条目结构）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单个因子的注册表条目。
 *
 * kind='column'：直接取某表某列，用 source 描述来源。
 * kind='computed'：现算（如 momentum_60），用 needs 声明所需列 + compute 计算函数。
 */
export interface RankFactorRegistryEntry {
  /** 因子 KEY（与所在 Record 的键一致）。 */
  key: RankFactorKey;
  /** 前端展示名。 */
  label: string;
  /** 是否历史可回测；false → 前端灰提示「禁历史回测」、校验放行但 warn。 */
  histAvailable: boolean;
  /** UI 初值与 legacy 兜底方向；运行时由 RankFactor.dir 覆盖。 */
  defaultDir: 'asc' | 'desc';
  /** 取值方式。 */
  kind: 'column' | 'computed';
  /** kind='column' 时：列来源（注册表内白名单常量，非前端串）。 */
  source?: { table: string; schema?: string; column: string };
  /** kind='computed' 时：所需列（alias 供 compute 取值）。 */
  needs?: Array<{
    table: string;
    schema?: string;
    column: string;
    alias: string;
  }>;
  /** kind='computed' 时：以 needs 的 alias 为键、计算因子值（缺值返回 null，不抛、不 ÷0）。 */
  compute?: (vals: Record<string, number | null>) => number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9 因子注册表（spec 02 §9 因子注册表）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 因子 KEY → 注册表条目。9 个条目，与 RankFactorKey 联合一一对应。
 * 列名 / schema / 默认 dir / histAvailable 严格按 spec 02 的表。
 */
export const RANK_FACTOR_REGISTRY: Record<
  RankFactorKey,
  RankFactorRegistryEntry
> = {
  pos_120: {
    key: 'pos_120',
    label: '120日价格位置',
    histAvailable: true,
    defaultDir: 'asc',
    kind: 'column',
    source: { table: 'signal_rolling_indicator', column: 'pos_120' },
  },
  pos_60: {
    key: 'pos_60',
    label: '60日价格位置',
    histAvailable: true,
    defaultDir: 'asc',
    kind: 'column',
    source: { table: 'signal_rolling_indicator', column: 'pos_60' },
  },
  close_ma60_ratio: {
    key: 'close_ma60_ratio',
    label: 'close/ma60 比',
    histAvailable: true,
    defaultDir: 'asc',
    kind: 'column',
    source: { table: 'signal_rolling_indicator', column: 'close_ma60_ratio' },
  },
  vol_ratio_60: {
    key: 'vol_ratio_60',
    label: '量比60',
    histAvailable: true,
    defaultDir: 'asc',
    kind: 'column',
    source: { table: 'signal_rolling_indicator', column: 'vol_ratio_60' },
  },
  vol_ratio_120: {
    key: 'vol_ratio_120',
    label: '量比120',
    histAvailable: true,
    defaultDir: 'asc',
    kind: 'column',
    source: { table: 'signal_rolling_indicator', column: 'vol_ratio_120' },
  },
  risk_reward: {
    key: 'risk_reward',
    label: '盈亏比',
    histAvailable: true,
    defaultDir: 'desc',
    kind: 'column',
    source: {
      table: 'daily_indicator',
      schema: 'raw',
      column: 'risk_reward_ratio',
    },
  },
  momentum_60: {
    key: 'momentum_60',
    label: '动量(ATR标准化)',
    histAvailable: true,
    defaultDir: 'desc',
    kind: 'computed',
    needs: [
      {
        table: 'daily_quote',
        schema: 'raw',
        column: 'qfq_close',
        alias: 'mom_close',
      },
      {
        table: 'daily_indicator',
        schema: 'raw',
        column: 'ma60',
        alias: 'mom_ma60',
      },
      {
        table: 'daily_indicator',
        schema: 'raw',
        column: 'atr_14',
        alias: 'mom_atr',
      },
    ],
    compute: (v) =>
      v.mom_close == null || v.mom_ma60 == null || !v.mom_atr
        ? null
        : (v.mom_close - v.mom_ma60) / v.mom_atr,
  },
  circ_mv: {
    key: 'circ_mv',
    label: '流通市值',
    histAvailable: true,
    defaultDir: 'asc',
    kind: 'column',
    source: { table: 'daily_basic', schema: 'raw', column: 'circ_mv' },
  },
  ml_score: {
    key: 'ml_score',
    label: 'ML 评分(前向专用)',
    histAvailable: false,
    defaultDir: 'desc',
    kind: 'column',
    source: { table: 'scores_daily', schema: 'ml', column: 'score' },
  },
};

/**
 * 合法因子 KEY 白名单（单一真相，service 校验用）。
 * legacy 单字段白名单 = 本集 ∪ {'none'}（见 07-service-and-frontend.md）。
 */
export const VALID_RANK_FACTOR_KEYS = new Set(
  Object.keys(RANK_FACTOR_REGISTRY),
);

// ─────────────────────────────────────────────────────────────────────────────
// 向后兼容适配器（legacy rankField → rankSpec，spec 01 §向后兼容适配器）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 source 的排序配置统一解析为 RankFactor[]，引擎 / loader 统一消费此结果。
 *
 *   rankSpec.factors 非空      → 直接返回（新配置优先）
 *   rankField === 'none'       → [] （legacy none）
 *   否则                       → [{ factor: rankField, weight:1, dir: rankDir }]（legacy 单因子）
 *
 * 纯函数，无 DB / NestJS 依赖。pos_120 / circ_mv 已在注册表中，legacy 路径自然落单因子分支。
 */
export function resolveRankSpec(source: PortfolioSimSource): RankFactor[] {
  if (source.rankSpec?.factors?.length) {
    return source.rankSpec.factors;
  }
  if (source.rankField === 'none') {
    return [];
  }
  return [{ factor: source.rankField, weight: 1, dir: source.rankDir }];
}
