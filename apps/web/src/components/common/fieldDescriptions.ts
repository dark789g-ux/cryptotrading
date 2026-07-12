/**
 * 字段说明字典（用户向）。
 *
 * key = 规范 conceptId，与策略条件字段 value（snake_case，conditionFieldMeta.ts）对齐。
 * 同一概念在不同界面用不同 key/label（条件字段 `kdj_j` / 表格列 `kdjJ` / A股筛选 `KDJ.J`），
 * 一律映射到这里同一个 conceptId，避免多处各写一份说明造成漂移。
 *
 * 只收录「需要解释」的非直观字段；MA5/开盘价/收盘价/成交额/上市时长 等一看就懂的不收录，
 * 缺 key ⇒ getFieldDescription 返回 undefined ⇒ FieldHelpTip 不渲染 "?"。
 *
 * 口径来源（已落源头核对，禁凭记忆）：
 * - macd_hist = MACD 柱 = 2×(DIF−DEA)：apps/server/src/market-data/active-mv/amv-formula.ts:87
 * - profit_loss_ratio = (high9 − close) / (close − low9)：apps/server/src/indicators/indicators-stream.ts:128-132
 *   （条件字段 profit_loss_ratio 与表格 riskRewardRatio 同列 risk_reward_ratio）
 * - stop_loss_pct = (1 − low9 / close) × 100：apps/server/src/indicators/indicators-stream.ts:130
 * - pos_120 / pos_60 / close_ma60_ratio / vol_ratio_60 / vol_ratio_120：
 *   docs/superpowers/specs/2026-06-09-signal-rolling-indicators-design/02-data-model-and-sql.md:40-45
 * - AMV/0AMV = 活跃市值（通达信式 MACD）：apps/server/src/market-data/active-mv/amv-formula.ts:1-12
 *   + apps/server/src/strategy-conditions/strategy-conditions.types.ts:51-67
 */
export const FIELD_DESCRIPTIONS: Record<string, string> = {
  // KDJ
  kdj_j: 'KDJ 随机指标的 J 值（=3K−2D），三条线里最敏感、波动最大。J 跌到 0 以下常视为短期超卖。',
  kdj_k: 'KDJ 随机指标的 K 值（快线），由 RSV 平滑而来，反映收盘价在近 N 日高低区间中的相对位置。',
  kdj_d: 'KDJ 随机指标的 D 值（慢线），由 K 值再平滑，比 K 更平缓，常作 K 的信号线。',

  // MACD
  macd_dif: 'MACD 的快慢均线差（DIF = EMA12 − EMA26），反映短中期动能方向。',
  macd_dea: 'MACD 的信号线（DEA = DIF 的 9 日 EMA），DIF 的平滑值。',
  macd_hist: 'MACD 柱 = 2 ×（DIF − DEA）。柱由负转正常视为动能转强。',

  // 均线综合 / 波动 / 止损
  bbi: '多空指标 BBI（MA3、MA6、MA12、MA24 的均值）。价在其上偏多、其下偏空。',
  atr14: '14 日平均真实波幅（ATR），衡量价格波动幅度，常用于设定止损距离。',
  loss_atr14: '收盘价减去 14 日 ATR（close − ATR14），按一个波幅单位设定的止损参考价。',
  stop_loss_pct: '止损幅度（%）=（1 − 近 9 日最低 ÷ 收盘）× 100，到近 9 日低点的回撤空间。',
  profit_loss_ratio:
    '盈亏比（风险回报比 RR）=（近 9 日最高 − 收盘）÷（收盘 − 近 9 日最低），向上空间相对向下止损空间的倍数，越大越划算。',

  // 砖形图
  brick: '砖形图（Renko）值：过滤时间、只按价格变动绘砖，用于识别趋势方向。',
  brick_delta: '砖形图相邻砖的变动量，反映砖形趋势的增减。',
  brick_xg: '砖形图选股信号（布尔）：砖形由下降转上升的拐点触发为真。',

  // VWAP（滚动成交量加权平均价）
  vwap5: 'VWAP5：过去 5 个交易日成交量加权平均价（前复权口径，元/股），反映近一周市场平均持仓成本。',
  vwap10: 'VWAP10：过去 10 个交易日成交量加权平均价（前复权口径，元/股），反映近两周市场平均持仓成本。',
  vwap20: 'VWAP20：过去 20 个交易日成交量加权平均价（前复权口径，元/股），反映近一月市场平均持仓成本。',

  // 量能 / 换手
  turnover_rate: '换手率（%）= 成交量 ÷ 流通股本，衡量当日交易活跃度。',
  volume_ratio:
    '量比 = 当日每分钟均量 ÷ 过去 5 日每分钟均量（来自日线基础数据），>1 表示放量。与「量比(60/120日均量)」口径不同。',
  obv5d: '成交额 OBV5D：最近 5 个交易日「涨加成交额、跌减成交额」的滚动累计，单位亿元（前端由千元换算）。严格模式：序列不足 5 根为空。',
  obv10d: '成交额 OBV10D：最近 10 个交易日「涨加成交额、跌减成交额」的滚动累计，单位亿元（前端由千元换算）。',
  obv20d: '成交额 OBV20D：最近 20 个交易日「涨加成交额、跌减成交额」的滚动累计，单位亿元（前端由千元换算）。',

  // 区间位置 / 偏离 / 滚动量比（signal_rolling_indicator）
  pos_120:
    '120 日区间位置 =（收盘 − 120 日最低）÷（120 日最高 − 120 日最低），取值 [0,1]，越接近 0 越靠近 120 日低点；不满 120 个交易日为空。',
  pos_60:
    '60 日区间位置 =（收盘 − 60 日最低）÷（60 日最高 − 60 日最低），取值 [0,1]，越接近 0 越靠近 60 日低点；不满 60 个交易日为空。',
  close_ma60_ratio:
    '收盘 ÷ 60 日均价，<1 表示价格跌破 60 日均线、越低偏离越多；不满 60 个交易日为空。',
  vol_ratio_60: '当日成交量 ÷（60 日均量 + 1），>1 表示相对近 60 日放量。（与日线「量比」口径不同）',
  vol_ratio_120: '当日成交量 ÷（120 日均量 + 1），>1 表示相对近 120 日放量。（与日线「量比」口径不同）',

  // 活跃市值（AMV）/ 行业 / 大盘 0AMV
  amv_dif: '个股活跃市值（AMV）序列的 MACD-DIF。活跃市值按通达信口径递推，反映资金活跃度的动能。',
  amv_dea: '个股活跃市值（AMV）序列的 MACD-DEA（DIF 的信号线）。',
  amv_macd: '个股活跃市值（AMV）序列的 MACD 柱（= 2×(DIF−DEA)）。',
  roc: '动量（ROC，变化率百分比）：(今收 − N 个交易日前收) / N 个交易日前收 × 100。正值代表上涨动量，负值代表下跌动量；无量纲，可跨标的比较。',
  roc10: '10 日动量（ROC10）：(今收 − 10 个交易日前收) / 10 个交易日前收 × 100。短期价格变化率。',
  roc20: '20 日动量（ROC20）：(今收 − 20 个交易日前收) / 20 个交易日前收 × 100。中期价格变化率。',
  roc60: '60 日动量（ROC60）：(今收 − 60 个交易日前收) / 60 个交易日前收 × 100。中长期价格变化率。',
  ind_amv_dif: '个股所属行业指数活跃市值（AMV）序列的 MACD-DIF，反映行业资金动能。',
  ind_amv_dea: '个股所属行业指数活跃市值（AMV）序列的 MACD-DEA。',
  ind_amv_macd: '个股所属行业指数活跃市值（AMV）序列的 MACD 柱。',
  oamv_dif: '大盘 0AMV（全市场活跃市值指数）的 MACD-DIF，作大盘择时参考；当日全市场同值。',
  oamv_dea: '大盘 0AMV（全市场活跃市值指数）的 MACD-DEA。',
  oamv_macd: '大盘 0AMV（全市场活跃市值指数）的 MACD 柱。',
  oamv_close: '大盘 0AMV 指数收盘值（全市场活跃市值指数当日点位）。',
  oamv_ma240: '大盘 0AMV 指数的 240 日均线（年线），常用作大盘多空/择时闸门。',

  // 估值
  pe: '市盈率（PE）= 股价 ÷ 每股收益，估值高低参考；亏损股为空。',
  pe_ttm: '滚动市盈率 PE(TTM)，用最近连续四个季度的每股收益计算，比静态 PE 更及时。',
  pb: '市净率（PB）= 股价 ÷ 每股净资产。',
  total_mv: '总市值 = 股价 × 总股本（单位：亿元）。',
  circ_mv: '流通市值 = 股价 × 流通股本（单位：亿元）。',

  // 资金流向
  net_inflow: '基准日主力资金净流入，单位万元（来自同花顺个股资金流）。',
  net_inflow_5d: '近 5 日主力净流入累计（最近 5 条记录），单位万元。',
  net_inflow_10d: '近 10 日主力净流入累计（最近 10 条记录），单位万元。',
  net_inflow_20d: '近 20 日主力净流入累计（最近 20 条记录），单位万元。',
};

/** 取字段说明；conceptId 缺失或未收录 → undefined（调用方据此决定不渲染 "?"）。 */
export function getFieldDescription(conceptId?: string): string | undefined {
  if (!conceptId) return undefined;
  return FIELD_DESCRIPTIONS[conceptId];
}
