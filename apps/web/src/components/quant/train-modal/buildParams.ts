/**
 * train Modal 参数装配工具：从 SFC 里抽出为独立模块，便于单测直接 import。
 *
 * CLAUDE.md 硬约束：n-date-picker daterange 的 [number, number] 是本地午夜 ms。
 * formatDateRange 必须用 getFullYear/getMonth/getDate，禁 getUTC*——曾把
 * `20260509` 漂成 `20260508` 导致整次同步看似完成实则一行未写。
 */
import type { JobRunType } from '@/api/modules/quant'
import type { E2EFormModel } from './TrainE2EFields.vue'

export interface TrainTriggerFormShape {
  run_type: JobRunType
  train: {
    feature_set_id: string
    model: 'lgb-lambdarank' | 'linear' | 'gbdt'
    walk_forward: boolean
    seed: number | null
  }
  e2e: E2EFormModel
  optuna: { feature_set_id: string; n_trials: number; space: string }
  seed_avg: { model_version_base: string; seedsText: string }
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

export function buildJobPayload(
  form: TrainTriggerFormShape,
  modeIsE2E: boolean,
): BuiltJobPayload {
  if (form.run_type === 'train' && modeIsE2E) {
    const e = form.e2e
    return {
      run_type: 'train_e2e',
      params: {
        factor_version: e.factor_version.trim(),
        label_scheme: e.label_scheme,
        new_listing_min_days: e.new_listing_min_days ?? 60,
        date_range: formatDateRange(e.date_range as [number, number]),
        model: e.model,
        walk_forward: e.walk_forward,
        seed: e.seed ?? 42,
      },
    }
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
