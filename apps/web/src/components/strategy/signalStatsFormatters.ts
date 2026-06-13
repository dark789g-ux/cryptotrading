// 信号逐笔明细共享格式化纯函数
// 出场方式（exitMode）/ 出场原因（exitReason）→ 中文标签的映射在此**单一收敛**，
// 各组件（SignalStatsTable / SignalStatsResult / SignalStatsView / SignalTestConfigPanel）一律复用，
// 禁止再在组件内硬编码副本——新增枚举值只需在此补一处，配套守门测试遍历全集兜底防漏渲染。

import type {
  SignalTest,
  SignalTestExitMode,
  SignalTestTrade,
} from '../../api/modules/strategy/signalStats'

export function fmtTradeDate(s: string): string {
  if (!s || s.length !== 8) return s
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

export function fmtRetPct(v: string): string {
  const n = parseFloat(v)
  if (isNaN(n)) return v
  return (n * 100).toFixed(2) + '%'
}

// ── exitReason → 标签 ────────────────────────────────────────────────────────
// 已知枚举（与 SignalTestTrade['exitReason'] 联合对齐）必须每个都有非兜底中文标签；
// 用 Record<联合, string> 让 TS 在新增枚举值时编译报缺键，运行态由守门测试兜底。
const EXIT_REASON_LABELS: Record<SignalTestTrade['exitReason'], string> = {
  max_hold: '强平',
  signal: '信号',
  delist: '退市',
  stop: '止损',
  ma5_exit: 'MA5离场',
  phase_lock_stop: '阶段止损',
  phase_lock_ma5: '阶段MA5离场',
}

/** 未知 reason 原样返回（兜底）；已知枚举均返回中文标签。 */
export function exitReasonLabel(reason: string): string {
  return EXIT_REASON_LABELS[reason as SignalTestTrade['exitReason']] ?? reason
}

// ── exitMode → 标签 ──────────────────────────────────────────────────────────
// 四个展示场景文案不同（列表/结果摘要/导入下拉/配置面板），各自一份 Record<联合, ...> 表，
// TS 强制覆盖全部枚举值，新增 exitMode 时漏填即编译报错；运行态由守门测试遍历全集兜底。

/** naive-ui NTag 的 type 取值子集（避免在纯函数文件里引入 naive-ui 类型）。 */
export type ExitModeTagType = 'info' | 'success' | 'warning' | 'default'

/** 列表「出场方式」列：NTag 颜色 + 含参标签（如 N=、≤maxHold）。 */
const EXIT_MODE_TAG: Record<
  SignalTestExitMode,
  { type: ExitModeTagType; label: (test: SignalTest) => string }
> = {
  fixed_n: { type: 'info', label: (t) => `固定N日(N=${t.horizonN ?? '?'})` },
  strategy: { type: 'warning', label: (t) => `条件出场(≤${t.maxHold ?? '?'})` },
  trailing_lock: {
    type: 'success',
    label: (t) => `波段跟踪止损(${t.maxHold == null ? '不封顶' : `≤${t.maxHold}`})`,
  },
  phase_lock: { type: 'success', label: () => '两阶段锁定止损' },
}

/** 列表「出场方式」列用：返回 NTag 颜色 type 与含参文案。未知 mode 兜底为 default + 原始串。 */
export function exitModeTag(test: SignalTest): { type: ExitModeTagType; label: string } {
  const e = EXIT_MODE_TAG[test.exitMode]
  if (!e) return { type: 'default', label: test.exitMode }
  return { type: e.type, label: e.label(test) }
}

/** 结果页配置摘要条用：含参精简文案。未知 mode 兜底为原始串。 */
const EXIT_MODE_SUMMARY: Record<SignalTestExitMode, (test: SignalTest) => string> = {
  fixed_n: (t) => `固定${t.horizonN}日`,
  strategy: (t) => `条件出场(≤${t.maxHold})`,
  trailing_lock: (t) => (t.maxHold == null ? '波段跟踪止损' : `波段跟踪止损(≤${t.maxHold})`),
  phase_lock: () => '两阶段锁定止损',
}

export function exitModeSummary(test: SignalTest): string {
  return EXIT_MODE_SUMMARY[test.exitMode]?.(test) ?? test.exitMode
}

/** 导入方案下拉用：最精简的纯模式名（不含参）。未知 mode 兜底为原始串。 */
const EXIT_MODE_SHORT_LABELS: Record<SignalTestExitMode, string> = {
  fixed_n: '固定天数',
  strategy: '策略条件',
  trailing_lock: '移动止损',
  phase_lock: '两阶段锁定止损',
}

export function exitModeShortLabel(mode: SignalTestExitMode | string): string {
  return EXIT_MODE_SHORT_LABELS[mode as SignalTestExitMode] ?? mode
}

/** 配置面板「出场模式」字段用：完整模式描述。未知 mode 兜底为原始串。 */
const EXIT_MODE_TEXT_LABELS: Record<SignalTestExitMode, string> = {
  fixed_n: '固定 N 个交易日',
  strategy: '卖出条件命中',
  trailing_lock: '波段跟踪止损',
  phase_lock: '两阶段锁定止损',
}

export function exitModeText(mode: SignalTestExitMode | string): string {
  return EXIT_MODE_TEXT_LABELS[mode as SignalTestExitMode] ?? mode
}

export function retColor(ret: string): string {
  const n = parseFloat(ret)
  return n >= 0 ? '#18a058' : '#d03050'
}
