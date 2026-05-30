/**
 * train Modal 参数装配工具：从 SFC 里抽出为独立模块，便于单测直接 import。
 *
 * CLAUDE.md 硬约束：n-date-picker daterange 的 [number, number] 是本地午夜 ms。
 * formatDateRange 必须用 getFullYear/getMonth/getDate，禁 getUTC*——曾把
 * `20260509` 漂成 `20260508` 导致整次同步看似完成实则一行未写。
 */
import type { JobRunType } from '@/api/modules/quant'
import type { E2EFormModel } from './TrainE2EFields.vue'
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
  train: {
    feature_set_id: string
    model: TrainModelKind
    walk_forward: boolean
    seed: number | null
    /** 仅 model ∈ {lgb-lambdarank, lgb-multiclass} 时有意义 */
    lgb?: LgbHyperModel
  }
  e2e: E2EFormModel
  optuna: { feature_set_id: string; n_trials: number; space: string }
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
 * 用于 LSTM 超参：用户留空（null）的字段不进 payload → 后端补 DEFAULT_LSTM_HYPERPARAMS，
 * 避免前端双源默认值。
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
 * E2E label_winsorize_lo / hi 是否成对（同填或同空）。只填一个返回 false（前端阻断提交）。
 */
export function isWinsorizePaired(e: E2EFormModel): boolean {
  const fl = e.featureLabel
  if (!fl) return true
  const loSet = fl.label_winsorize_lo != null
  const hiSet = fl.label_winsorize_hi != null
  return loSet === hiSet
}

/**
 * 把 E2E 特征/标签参数打包进 params（仅非 null 项；neutralize 枚举映射；winsorize 成对打包）。
 * fwd_horizon_days 仅 fwd_5d_ret、max_hold_days 仅 strategy-aware 时打包。
 */
function applyFeatureLabelParams(
  params: Record<string, unknown>,
  e: E2EFormModel,
): void {
  const fl = e.featureLabel
  if (!fl) return
  if (fl.neutralize_cols != null) {
    params.neutralize_cols = mapNeutralizeCols(fl.neutralize_cols)
  }
  if (fl.robust_z != null) {
    params.robust_z = fl.robust_z
  }
  if (fl.factor_clip_sigma != null) {
    params.factor_clip_sigma = fl.factor_clip_sigma
  }
  // 区间成对：二者均非 null 才打包（只填一个由 isWinsorizePaired 在提交前阻断）
  if (fl.label_winsorize_lo != null && fl.label_winsorize_hi != null) {
    params.label_winsorize = [fl.label_winsorize_lo, fl.label_winsorize_hi]
  }
  if (e.label_scheme === 'fwd_5d_ret' && fl.fwd_horizon_days != null) {
    params.fwd_horizon_days = fl.fwd_horizon_days
  }
  if (e.label_scheme === 'strategy-aware' && fl.max_hold_days != null) {
    params.max_hold_days = fl.max_hold_days
  }
}

export function buildJobPayload(
  form: TrainTriggerFormShape,
  modeIsE2E: boolean,
): BuiltJobPayload {
  if (form.run_type === 'train' && modeIsE2E) {
    const e = form.e2e
    const params: Record<string, unknown> = {
      factor_version: e.factor_version.trim(),
      label_scheme: e.label_scheme,
      new_listing_min_days: e.new_listing_min_days ?? 60,
      date_range: formatDateRange(e.date_range as [number, number]),
      model: e.model,
      walk_forward: e.walk_forward,
      seed: e.seed ?? 42,
    }
    // dir3_band 横盘阈值 ε：仅 dir3_band 家族选择器有意义；null/空 → 走后端默认 0.005。
    // 编解码（ε→canonical scheme 串）由后端 dir3_scheme.py 单一源完成，前端只透原始 ε。
    if (e.label_scheme === 'dir3_band') {
      params.dir3_band_eps = e.dir3_band_eps ?? 0.005
    }
    // 模型超参（仅打包用户显式填写的项 → 后端补默认，避免双源默认值）
    if (e.model === 'lstm' && e.lstm) {
      const hp = pickDefined(e.lstm as unknown as Record<string, unknown>)
      if (Object.keys(hp).length > 0) params.hyperparams = hp
    } else if (isLgbModel(e.model) && e.lgb) {
      const hp = pickDefined(e.lgb as unknown as Record<string, unknown>)
      if (Object.keys(hp).length > 0) params.hyperparams = hp
    }
    // 特征/标签参数（E2E 专属；普通 train 不打包，特征矩阵已由 feature_set_id 固定）
    applyFeatureLabelParams(params, e)
    return { run_type: 'train_e2e', params }
  }
  if (form.run_type === 'train') {
    const p: Record<string, unknown> = {
      feature_set_id: form.train.feature_set_id.trim(),
      model: form.train.model,
      walk_forward: form.train.walk_forward,
    }
    if (form.train.seed !== null && form.train.seed !== undefined) {
      p.seed = form.train.seed
    }
    // 普通 train 的 lgb 超参（early_stopping_rounds UI 已 disabled，pickDefined 自然不含它）
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
        feature_set_id: form.optuna.feature_set_id.trim(),
        n_trials: form.optuna.n_trials,
        space: form.optuna.space.trim(),
      },
    }
  }
  if (form.run_type === 'seed_avg') {
    return {
      run_type: 'seed_avg',
      params: {
        model_version_base: form.seed_avg.model_version_base.trim(),
        seeds: parseSeedsText(form.seed_avg.seedsText),
      },
    }
  }
  return { run_type: form.run_type, params: {} }
}
