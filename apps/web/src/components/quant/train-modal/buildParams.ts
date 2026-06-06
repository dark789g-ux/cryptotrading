/**
 * train Modal 参数装配工具：从 SFC 里抽出为独立模块，便于单测直接 import。
 *
 * CLAUDE.md 硬约束：n-date-picker daterange 的 [number, number] 是本地午夜 ms。
 * formatDateRange 必须用 getFullYear/getMonth/getDate，禁 getUTC*——曾把
 * `20260509` 漂成 `20260508` 导致整次同步看似完成实则一行未写。
 *
 * 2026-06-06 close_adj 纯后复权改造 spec：
 * - 删 train_e2e / E2E 模式；训练 modal 只保留 train/optuna/seed_avg
 * - 三类训练均改为消费已备 feature_set，params = { feature_set_id, date_range, ... }
 * - isDateDisabled：按 coverage 段禁用不在任一段内的日期（区间外 + 空洞）
 */
import type { JobRunType } from '@/api/modules/quant'
import type { CoverageSegment } from '@/api/modules/quant'
import type { LgbHyperModel } from './LgbHyperFields.vue'
import type { NeutralizeCols } from './FeatureLabelFields.vue'

export type TrainModelKind =
  | 'lgb-lambdarank'
  | 'lgb-multiclass'
  | 'linear'
  | 'gbdt'
  | 'lstm'

export interface TrainTriggerFormShape {
  run_type: JobRunType
  /** 三类训练（train/optuna/seed_avg）共享字段 */
  shared: {
    feature_set_id: string
    date_range: [number, number] | null
  }
  train: {
    model: TrainModelKind
    walk_forward: boolean
    seed: number | null
    /** 仅 model ∈ {lgb-lambdarank, lgb-multiclass} 时有意义 */
    lgb?: LgbHyperModel
  }
  optuna: { n_trials: number; space: string }
  seed_avg: { model_version_base: string; seedsText: string }
}

/** model ∈ {lgb-lambdarank, lgb-multiclass} 共享 LightGBM 树参数 */
export function isLgbModel(model: string): boolean {
  return model === 'lgb-lambdarank' || model === 'lgb-multiclass'
}

/**
 * neutralize_cols 前端三档枚举 → 后端语义数组（01-frontend.md §FeatureLabelFields）：
 *   none → []，industry → ['industry_l1']，industry_mv → ['industry_l1','mv']
 */
export function mapNeutralizeCols(v: NeutralizeCols): string[] {
  switch (v) {
    case 'none':
      return []
    case 'industry':
      return ['industry_l1']
    case 'industry_mv':
      return ['industry_l1', 'mv']
  }
}

/**
 * 过滤对象中 null / undefined 的项，**保留 0 与 false**（业务有效值）。
 */
export function pickDefined<T extends Record<string, unknown>>(
  obj: T,
): Partial<T> {
  const out: Partial<T> = {}
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const v = obj[key]
    if (v !== null && v !== undefined) {
      out[key] = v
    }
  }
  return out
}

export interface BuiltJobPayload {
  run_type: JobRunType
  params: Record<string, unknown>
}

/**
 * 把 n-date-picker daterange 的 [startMs, endMs]（本地午夜 ms）转为后端期望的
 * "YYYYMMDD:YYYYMMDD" 字符串。
 *
 * CLAUDE.md 硬约束：用 getFullYear/getMonth/getDate（本地 TZ），禁 getUTC*。
 * 曾把 `20260509` 漂成 `20260508`（CST 用户 UTC 差 8h）。
 */
export function formatDateRange(range: [number, number]): string {
  const fmt = (ms: number) => {
    const d = new Date(ms)
    // CLAUDE.md 硬约束：本地午夜口径，禁 getUTC*
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}${m}${day}`
  }
  return `${fmt(range[0])}:${fmt(range[1])}`
}

export function parseSeedsText(text: string): number[] {
  return text
    .split(/[,，\s]+/)
    .map(x => x.trim())
    .filter(x => x.length > 0)
    .map(x => Number(x))
    .filter(n => Number.isFinite(n) && Number.isInteger(n))
}

/**
 * is-date-disabled 核心逻辑（纯函数，便于单测）。
 *
 * ts 是 n-date-picker 传入的时间戳（本地午夜 ms）。
 * 把它转成 YYYYMMDD 字符串后，检查是否落在 coverage 的任一段内（含端点）。
 * 不落在任何段内（区间外 + 空洞）返回 true（禁用）。
 *
 * coverage 段的 start/end 是 YYYYMMDD 字符串，直接字符串比较（字典序 == 时间序）。
 */
export function isDateDisabled(ts: number, coverage: CoverageSegment[]): boolean {
  if (coverage.length === 0) return true
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const dateStr = `${y}${m}${day}`
  return !coverage.some(seg => dateStr >= seg.start && dateStr <= seg.end)
}

export function buildJobPayload(
  form: TrainTriggerFormShape,
): BuiltJobPayload {
  const { feature_set_id, date_range } = form.shared
  const dateRangeStr = date_range ? formatDateRange(date_range) : ''

  if (form.run_type === 'train') {
    const p: Record<string, unknown> = {
      feature_set_id: feature_set_id.trim(),
      date_range: dateRangeStr,
      model: form.train.model,
      walk_forward: form.train.walk_forward,
    }
    if (form.train.seed !== null && form.train.seed !== undefined) {
      p.seed = form.train.seed
    }
    if (isLgbModel(form.train.model) && form.train.lgb) {
      const hp = pickDefined(form.train.lgb as unknown as Record<string, unknown>)
      if (Object.keys(hp).length > 0) p.hyperparams = hp
    }
    return { run_type: 'train', params: p }
  }
  if (form.run_type === 'optuna') {
    return {
      run_type: 'optuna',
      params: {
        feature_set_id: feature_set_id.trim(),
        date_range: dateRangeStr,
        n_trials: form.optuna.n_trials,
        space: form.optuna.space.trim(),
      },
    }
  }
  if (form.run_type === 'seed_avg') {
    return {
      run_type: 'seed_avg',
      params: {
        feature_set_id: feature_set_id.trim(),
        date_range: dateRangeStr,
        model_version_base: form.seed_avg.model_version_base.trim(),
        seeds: parseSeedsText(form.seed_avg.seedsText),
      },
    }
  }
  return { run_type: form.run_type, params: {} }
}
