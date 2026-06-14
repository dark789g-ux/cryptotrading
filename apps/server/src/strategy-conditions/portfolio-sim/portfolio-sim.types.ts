/**
 * portfolio-sim.types.ts
 *
 * 组合级模拟器（W1）配置与输入/输出类型定义（纯类型，不依赖 DB / NestJS）。
 *
 * 设计参照 signal-stats：纯逻辑（portfolio-sim.engine.ts）与 DB 装载（后续任务）分离。
 * 本文件钉死引擎核的输入输出契约——字段名不可随意改（后续 loader / 持久化层消费）。
 *
 * 口径基准：02 引擎设计（逐日回放：出场 → 开仓 → 盯市 → 记录）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 排序契约（rankSpec 统一，保留 legacy 字段）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 多因子排序的因子 KEY 联合（9 值，与 portfolio-sim.factor-registry.ts 注册表 keys 同源）。
 *
 * 显式字面量联合而非从注册表派生，以保持本文件「纯类型、不 import 注册表」原则
 * （避免 types ←→ registry 循环依赖；注册表反向 import 本类型）。
 * 注册表的 RANK_FACTOR_REGISTRY 必须恰好覆盖这 9 个 key（spec 02 §VALID 集派生）。
 */
export type RankFactorKey =
  | 'pos_120'
  | 'pos_60'
  | 'close_ma60_ratio'
  | 'vol_ratio_60'
  | 'vol_ratio_120'
  | 'risk_reward'
  | 'momentum_60'
  | 'circ_mv'
  | 'ml_score';

/** 单个排序因子：因子 KEY + 权重 + 方向。 */
export interface RankFactor {
  /** 因子 KEY（注册表白名单内）。 */
  factor: RankFactorKey;
  /** 该因子在 composite 综合分中的权重（>0）。 */
  weight: number;
  /** 排序方向：asc=值小者优先、desc=值大者优先。 */
  dir: 'asc' | 'desc';
}

/**
 * 排序规格：因子数组。
 * [] = none（按 ts_code 升序）、len1 = 单因子、len>1 = composite 多因子加权。
 */
export interface RankSpec {
  factors: RankFactor[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 仓位契约（Phase 2，SizingConfig）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 动态仓位配置（Phase 2）。缺省 = fixed（固定 positionRatio）。
 * fixed 不读 floorMult/capMult/kellyFraction/kellyMaxMult 字段。
 */
export interface SizingConfig {
  /** 仓位模式。缺省 'fixed'。 */
  mode: 'fixed' | 'signal_weighted' | 'source_kelly';
  /** signal_weighted 最差信号乘子，默认 0.5（须 >0）。 */
  floorMult: number;
  /** signal_weighted 最优信号乘子，默认 1.5（须 ≥ floorMult）。 */
  capMult: number;
  /** source_kelly half-kelly 系数，默认 0.5，范围 (0,1]。 */
  kellyFraction: number;
  /** source_kelly 乘子上限，默认 1.0，范围 (0,∞)。 */
  kellyMaxMult: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 熔断契约（Phase 3，CircuitBreaker，挂 PortfolioSimConfig 账户级）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 账户级熔断配置（Phase 3）。缺省 = 全关。
 * 连亏熔断（cooldown）+ 回撤熔断（drawdown）双触发，anchorMode 下强制全旁路。
 */
export interface CircuitBreaker {
  /** 连亏熔断开关（移植 cooldown.ts）。 */
  enableCooldown: boolean;
  /** 连亏 N 笔触发，正整数。 */
  consecutiveLossesThreshold: number;
  /** 基础冷却交易日数。 */
  baseCooldownDays: number;
  /** 冷却上限（≥ base）。 */
  maxCooldownDays: number;
  /** 每次亏损延长天数（非负整数）。 */
  extendOnLoss: number;
  /** 每次盈利缩短天数（非负整数）。 */
  reduceOnProfit: number;
  /** 回撤熔断开关。 */
  enableDrawdownHalt: boolean;
  /** 自峰值回撤 ≥ 此值停开仓，如 0.15。 */
  drawdownHaltPct: number;
  /** 回升到回撤 ≤ 此值恢复（滞回），须 ≤ haltPct。 */
  drawdownResumePct: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置类型
// ─────────────────────────────────────────────────────────────────────────────

/** 单个信号源（一个既有 A 股回测 run），含该策略的仓位 / 约束 / 排序规则。 */
export interface PortfolioSimSource {
  /** 既有 signal-stats run 的 id（逐笔交易来源）。 */
  runId: string;
  /** 该策略的人类可读标签；用于 strategyExposure 的 key（须组内唯一）。 */
  label: string;
  /** 单票权重占 NAV_ref，(0,1]。alloc = positionRatio × NAV_ref(d)。 */
  positionRatio: number;
  /** 该策略最大同时在仓数；null = 不限。 */
  maxPositions: number | null;
  /** 该策略总敞口上限占 NAV_ref；null = 不限。严格 > cap 才 skip(exposure_cap)。 */
  exposureCap: number | null;
  /**
   * 【保留 legacy】同日候选超额时的单排序字段（决定优先级）。'none' = 不排序（按 ts_code 升序）。
   * 引擎统一经 resolveRankSpec 适配为 rankSpec 消费，不再直接读此字段。
   */
  rankField: 'pos_120' | 'circ_mv' | 'none';
  /** 【保留 legacy】排序方向（仅 rankField !== 'none' 时有意义）。 */
  rankDir: 'asc' | 'desc';
  /** 【新增】多因子排序规格；存在且 factors 非空 → 接管排序（优先于 rankField）。 */
  rankSpec?: RankSpec;
  /** 【新增】动态仓位配置（Phase 2）；缺省 = fixed。 */
  sizing?: SizingConfig;
}

/** 交易成本费率（均为小数费率，单边）。 */
export interface PortfolioSimCostRates {
  /** 佣金（单边）。 */
  commissionPerSide: number;
  /** 过户费（单边）。 */
  transferPerSide: number;
  /** 印花税（仅卖出）：exitDate < '20230828'（2023-08-28 减半前）。 */
  stampSellBefore20230828: number;
  /** 印花税（仅卖出）：exitDate >= '20230828'（减半后）。 */
  stampSellFrom20230828: number;
  /** 滑点（单边）。 */
  slippagePerSide: number;
}

/** 组合模拟整体配置。 */
export interface PortfolioSimConfig {
  /** 信号源列表；开仓时按此数组顺序逐策略处理。 */
  sources: PortfolioSimSource[];
  /** 初始资金（首日 NAV_ref）。 */
  initialCapital: number;
  /** 成本费率。 */
  cost: PortfolioSimCostRates;
  /**
   * 锚点模式：maxPositions/exposureCap 视为 null、already_held 规则停用、费率全 0。
   * 此时每笔信号必 taken，且 realizedRetNet ≡ ret（代数恒等）。
   */
  anchorMode: boolean;
  /** 【新增】账户级熔断（Phase 3）；缺省 = 全关。anchorMode 下强制全旁路。 */
  circuitBreaker?: CircuitBreaker;
}

// ─────────────────────────────────────────────────────────────────────────────
// 引擎输入（由调用方 / loader 准备，引擎不查库）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一笔来自某 run 的逐笔交易（signal_test_trade）。
 *
 * sourceIdx 指向 config.sources 的下标（决定该笔属于哪个策略、用哪套约束 / 排序）。
 * ret 是该笔的记录前向收益（exit_price/buy_price - 1）；组合回放直接复用，不重算路径。
 */
export interface EngineTrade {
  /** 所属信号源下标（config.sources[sourceIdx]）。 */
  sourceIdx: number;
  /** 标的代码。 */
  tsCode: string;
  /** 信号日 T（YYYYMMDD）。 */
  signalDate: string;
  /** 买入日 T+1（YYYYMMDD）；开仓发生在此交易日。 */
  buyDate: string;
  /** 出场日（YYYYMMDD）；收口发生在此交易日。 */
  exitDate: string;
  /** 记录前向收益（exit_price/buy_price - 1）。出场毛回款 = alloc × (1 + ret)。 */
  ret: number;
  /** 持仓交易日数（来自 signal_test_trade，仅透传；引擎不依赖其做时序）。 */
  holdDays: number;
  /**
   * 【legacy 兼容保留】排序字段值（rankField 对应）；缺失（null）项排在有值项之后。
   * 新流程 loader 统一写 null，综合分由引擎 rankAndScore 计算（见 spec 01）。
   */
  rankValue: number | null;
  /**
   * 【新增】多因子原始值（loader 按注册表装载）；composite/单因子排序用。
   * 缺值因子置 null（LEFT JOIN 未命中 / 列 NULL / momentum 分母 0）。
   */
  factorValues?: Record<RankFactorKey, number | null>;
}

/** 单个交易日的行情（qfq 价）。用于盯市。 */
export interface EngineQuoteBar {
  /** 前复权开盘价。入场首日盯市分母。 */
  open: number;
  /** 前复权收盘价。盯市分子 / 每日盯市基准。 */
  close: number;
}

/**
 * 引擎输入：逐笔交易 + 行情 + 日历。
 *
 * quotes: 每个 tsCode 一张 Map<tradeDate, {open, close}>。
 *   缺该日 key = 该 ts_code 当日停牌（盯市时 mv 不变、不更新盯市价）。
 * calendar: 升序 SSE 交易日，须覆盖整个回放窗口（首个 buyDate 到末个 exitDate）。
 */
export interface EngineInput {
  config: PortfolioSimConfig;
  trades: EngineTrade[];
  quotes: Map<string, Map<string, EngineQuoteBar>>;
  calendar: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 引擎输出
// ─────────────────────────────────────────────────────────────────────────────

/** 单个交易日的净值快照。 */
export interface EngineDailyRow {
  /** 交易日（YYYYMMDD）。 */
  tradeDate: string;
  /** 当日收盘 NAV = cash + Σmv。 */
  nav: number;
  /** 当日收盘现金。 */
  cash: number;
  /** 当日收益率 = NAV(d)/NAV(d-1) - 1（首日分母 initialCapital）。 */
  dailyRet: number;
  /** 当日收盘在仓持仓数（合计，跨策略）。 */
  positionCount: number;
  /** 当日收盘总敞口 = Σmv / NAV(d)。 */
  exposure: number;
  /** 各策略收盘敞口 {label: Σ策略mv / NAV(d)}。无持仓策略不出现在内（或为 0）。 */
  strategyExposure: Record<string, number>;
}

/** 单笔信号的判定结果（taken / skipped）。 */
export interface EngineFill {
  sourceIdx: number;
  tsCode: string;
  signalDate: string;
  buyDate: string;
  /** taken=成交开仓；skipped=被约束拒绝（skipReason 给原因）。 */
  status: 'taken' | 'skipped';
  /** 被拒绝原因（status='skipped' 时给出）。 */
  skipReason?: SkipReason;
  /** 该信号的排序值（透传 EngineTrade.rankValue）。 */
  rankValue: number | null;
  /** 入场权重（成交时 = positionRatio）。 */
  weightEntry?: number;
  /** 入场金额（成交时 = positionRatio × NAV_ref(buyDate)）。 */
  alloc?: number;
  /** 出场日（成交时透传）。 */
  exitDate?: string;
  /** 净实现收益率（含买卖费用）；anchorMode 下 ≡ ret。 */
  realizedRetNet?: number;
  /** 该笔买 + 卖费用绝对额合计（成交时给出）。 */
  costsPaid?: number;
  /**
   * 【新增】综合排序分 / 单因子值（落 rank_score）；由引擎 rankAndScore 写入。
   * taken/skipped 均可有（冻结日仍跑 rankAndScore 算分，只是不开仓）。
   */
  rankScore?: number | null;
  /**
   * 【新增】逐因子原始值透明展示（落 factor_values jsonb）；fills 初始化即从 trade 透传，
   * 与开仓路径解耦——熔断冻结被 skip 的 fill 也带此字段。
   */
  factorValues?: Record<RankFactorKey, number | null>;
}

/** 开仓被拒绝的原因（按引擎检查顺序）。 */
export type SkipReason =
  | 'already_held' // 该策略已持有同 ts_code
  | 'slots_full' // 该策略在仓数 >= maxPositions
  | 'exposure_cap' // (该策略持仓市值 + alloc)/NAV_ref > exposureCap（严格 >）
  | 'cash_short' // cash < alloc + 买费
  | 'cooldown' // 【Phase 3】连亏熔断冷却期内冻结开仓
  | 'drawdown_halt' // 【Phase 3】回撤熔断停开仓
  | 'sized_out'; // 【Phase 2】source_kelly 负期望源 alloc≈0

/** 组合回放汇总指标。 */
export interface EngineSummary {
  /** 末日 NAV。 */
  finalNav: number;
  /** 总收益 = finalNav/initialCapital - 1。 */
  totalRet: number;
  /** 年化 = (1+totalRet)^(244/交易日数) - 1；finalNav<=0 时 null。 */
  annualRet: number | null;
  /** 最大回撤（负数，NAV 峰值回落最大比例）；无回撤为 0。 */
  maxDrawdown: number;
  /** 夏普 = mean(dailyRet)/std(dailyRet) × √244（样本标准差 n-1）；std=0 时 null。 */
  sharpe: number | null;
  /** 卡玛 = annualRet/|maxDrawdown|；回撤为 0 或 annualRet null 时 null。 */
  calmar: number | null;
  /** 日胜率（来自 calcSignalStats(dailyRet 序列).winRate）。 */
  dailyWinRate: number | null;
  /** 日凯利（来自 calcSignalStats(dailyRet 序列).kellyF）。 */
  dailyKelly: number | null;
  /** 成交信号数。 */
  nTaken: number;
  /** 被拒绝信号数。 */
  nSkipped: number;
  /** 全部买卖费用绝对额合计。 */
  totalCosts: number;
}

/** 引擎完整输出。 */
export interface EngineResult {
  dailyRows: EngineDailyRow[];
  fills: EngineFill[];
  summary: EngineSummary;
}
