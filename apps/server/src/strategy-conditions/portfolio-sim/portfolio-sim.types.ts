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
  /** 同日候选超额时的排序字段（决定优先级）。'none' = 不排序（按 ts_code 升序）。 */
  rankField: 'pos_120' | 'circ_mv' | 'none';
  /** 排序方向（仅 rankField !== 'none' 时有意义）。 */
  rankDir: 'asc' | 'desc';
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
  /** 排序字段值（rankField 对应）；缺失（null）项排在有值项之后。 */
  rankValue: number | null;
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
}

/** 开仓被拒绝的原因（按引擎检查顺序）。 */
export type SkipReason =
  | 'already_held' // 该策略已持有同 ts_code
  | 'slots_full' // 该策略在仓数 >= maxPositions
  | 'exposure_cap' // (该策略持仓市值 + alloc)/NAV_ref > exposureCap（严格 >）
  | 'cash_short'; // cash < alloc + 买费

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
