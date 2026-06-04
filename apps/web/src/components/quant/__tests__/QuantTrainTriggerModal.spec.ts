/**
 * QuantTrainTriggerModal + train-modal/buildParams 单测。
 *
 * 2026-06-05 quant-label-management spec 更新：
 *  - label_scheme 字段废弃，改为 labelKey（label_id:label_version）
 *  - canSubmit 检查 labelKey 而非 label_scheme
 *  - buildParams 输出 labelRef 而非 label_scheme 在 params 里
 *
 * 覆盖：
 *  (1) run_type='train' 默认显示 TrainE2EFields
 *  (2) mode switch 切到"使用现有 feature_set"后 TrainE2EFields 隐藏
 *  (3) factor_version 空时提交按钮 disabled
 *  (4) buildParams 输出 run_type='train_e2e' + labelRef
 *  (5) formatDateRange 用本地午夜：new Date(2026, 4, 9) → '20260509'（不漂前/后）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import QuantTrainTriggerModal from '../QuantTrainTriggerModal.vue'
import TrainE2EFields from '../train-modal/TrainE2EFields.vue'
import {
  buildJobPayload,
  formatDateRange,
  type TrainTriggerFormShape,
} from '../train-modal/buildParams'

// vue-router stub：useRouter() 在 SFC 内调用，必须 mock
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
}))

// quantApi stub：避免真发请求
vi.mock('@/api/modules/quant', async () => {
  const actual = await vi.importActual<typeof import('@/api/modules/quant')>(
    '@/api/modules/quant',
  )
  return {
    ...actual,
    quantApi: {
      createJob: vi.fn().mockResolvedValue({ id: 'job-abc-12345678' }),
      listFactorVersions: vi.fn().mockResolvedValue({ versions: ['v1'] }),
      listLabels: vi.fn().mockResolvedValue({ items: [] }),
    },
  }
})

// 用 NMessageProvider 包裹，确保 useMessage 不抛
function mountModal() {
  const Wrapper = defineComponent({
    components: { NConfigProvider, NMessageProvider, QuantTrainTriggerModal },
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () => h(QuantTrainTriggerModal, { show: true }),
            }),
        })
    },
  })
  return mount(Wrapper, { attachTo: document.body })
}

function getModalVm(wrapper: ReturnType<typeof mountModal>) {
  const inner = wrapper.findComponent(QuantTrainTriggerModal)
  expect(inner.exists()).toBe(true)
  return inner.vm as unknown as {
    form: TrainTriggerFormShape & { priority: number; run_type: string }
    modeIsE2E: boolean
    canSubmit: boolean
    buildParams: () => { run_type: string; params: Record<string, unknown>; labelRef?: { label_id: string; label_version: string } }
    onSubmit: () => Promise<void>
  }
}

describe('QuantTrainTriggerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("run_type='train' 默认显示 TrainE2EFields（D-8 默认端到端）", async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()

    const e2e = wrapper.findComponent(TrainE2EFields)
    expect(e2e.exists()).toBe(true)
  })

  it('mode switch 切到"使用现有 feature_set"后 TrainE2EFields 隐藏', async () => {
    const wrapper = mountModal()
    await nextTick()
    const vm = getModalVm(wrapper)

    expect(wrapper.findComponent(TrainE2EFields).exists()).toBe(true)
    ;(vm as unknown as { modeIsE2E: boolean }).modeIsE2E = false
    await nextTick()
    expect(wrapper.findComponent(TrainE2EFields).exists()).toBe(false)
  })

  it('factor_version 空时提交按钮 disabled', async () => {
    const wrapper = mountModal()
    await nextTick()
    const vm = getModalVm(wrapper)

    // 端到端模式默认：factor_version='' → canSubmit=false
    expect(vm.canSubmit).toBe(false)

    // 灌齐其他必填字段，仅留 factor_version 空（labelKey 也填）
    vm.form.e2e.labelKey = 'my_label:v1'
    vm.form.e2e.date_range = [new Date(2026, 4, 1).getTime(), new Date(2026, 4, 31).getTime()]
    vm.form.e2e.model = 'lgb-lambdarank'
    await nextTick()
    expect(vm.canSubmit).toBe(false)

    // 补齐 factor_version → canSubmit=true
    vm.form.e2e.factor_version = 'v1'
    await nextTick()
    expect(vm.canSubmit).toBe(true)
  })

  it("buildParams 输出 run_type='train_e2e' + labelRef（不含 label_scheme）", async () => {
    const wrapper = mountModal()
    await nextTick()
    const vm = getModalVm(wrapper)

    vm.form.e2e.factor_version = 'v1'
    vm.form.e2e.labelKey = 'fwd_ret_h1:v1'
    vm.form.e2e.new_listing_min_days = 30
    vm.form.e2e.date_range = [new Date(2026, 4, 9).getTime(), new Date(2026, 4, 11).getTime()]
    vm.form.e2e.model = 'lgb-lambdarank'
    vm.form.e2e.walk_forward = true
    vm.form.e2e.seed = 7
    await nextTick()

    const payload = vm.buildParams()
    expect(payload.run_type).toBe('train_e2e')
    expect(payload.params).toMatchObject({
      factor_version: 'v1',
      new_listing_min_days: 30,
      date_range: '20260509:20260511',
      model: 'lgb-lambdarank',
      walk_forward: true,
      seed: 7,
    })
    // labelRef 在顶层，不在 params 里
    expect(payload.labelRef).toEqual({ label_id: 'fwd_ret_h1', label_version: 'v1' })
    expect('label_scheme' in payload.params).toBe(false)
  })

  it("buildParams 在 min_days / seed 为 null 时回填后端默认 60 / 42", async () => {
    const wrapper = mountModal()
    await nextTick()
    const vm = getModalVm(wrapper)

    vm.form.e2e.factor_version = 'v2'
    vm.form.e2e.labelKey = 'tercile_label:v1'
    vm.form.e2e.new_listing_min_days = null
    vm.form.e2e.date_range = [new Date(2026, 0, 1).getTime(), new Date(2026, 0, 10).getTime()]
    vm.form.e2e.model = 'gbdt'
    vm.form.e2e.walk_forward = false
    vm.form.e2e.seed = null
    await nextTick()

    const payload = vm.buildParams()
    expect(payload.run_type).toBe('train_e2e')
    expect(payload.params.new_listing_min_days).toBe(60)
    expect(payload.params.seed).toBe(42)
    expect(payload.params.date_range).toBe('20260101:20260110')
  })

  it('onSubmit 把 labelRef 映射为 wire 键 label_ref 传给 createJob（端到端契约防回归）', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()
    const vm = getModalVm(wrapper)

    vm.form.e2e.factor_version = 'v1'
    vm.form.e2e.labelKey = 'next_day_band05:v1'
    vm.form.e2e.date_range = [new Date(2026, 4, 1).getTime(), new Date(2026, 4, 31).getTime()]
    vm.form.e2e.model = 'lgb-lambdarank'
    await nextTick()
    expect(vm.canSubmit).toBe(true)

    await vm.onSubmit()
    await flushPromises()

    const { quantApi } = await import('@/api/modules/quant')
    const createJobMock = quantApi.createJob as unknown as ReturnType<typeof vi.fn>
    expect(createJobMock).toHaveBeenCalledTimes(1)
    const body = createJobMock.mock.calls[0][0] as Record<string, unknown>
    // wire 键必须是 snake_case label_ref（与后端 DTO body.label_ref 对齐），
    // 不能回归成 camelCase labelRef —— 这是 C-1 漏网的根因，本断言守住它。
    expect(body.label_ref).toEqual({ label_id: 'next_day_band05', label_version: 'v1' })
    expect('labelRef' in body).toBe(false)
  })
})

describe('formatDateRange (本地午夜口径，CLAUDE.md 硬约束)', () => {
  it('new Date(2026,4,9) (May 9 本地) → "20260509"，不漂前/后', () => {
    const ms1 = new Date(2026, 4, 9).getTime()
    const ms2 = new Date(2026, 4, 11).getTime()
    expect(formatDateRange([ms1, ms2])).toBe('20260509:20260511')
  })

  it('跨月边界日期不漂', () => {
    const ms1 = new Date(2026, 0, 1).getTime()
    const ms2 = new Date(2026, 11, 31).getTime()
    expect(formatDateRange([ms1, ms2])).toBe('20260101:20261231')
  })

  it('单数月份/日期补零', () => {
    const ms = new Date(2026, 2, 5).getTime()
    expect(formatDateRange([ms, ms])).toBe('20260305:20260305')
  })
})

describe('buildJobPayload (工具模块直测)', () => {
  function freshForm(): TrainTriggerFormShape {
    return {
      run_type: 'train',
      train: { feature_set_id: '', model: 'lgb-lambdarank', walk_forward: true, seed: null },
      e2e: {
        factor_version: 'v1',
        labelKey: 'strategy_label:v1',
        new_listing_min_days: 60,
        date_range: [new Date(2026, 4, 9).getTime(), new Date(2026, 4, 11).getTime()],
        model: 'lgb-lambdarank',
        walk_forward: true,
        seed: 42,
      },
      optuna: { feature_set_id: '', n_trials: 50, space: 'lgb-4knobs' },
      seed_avg: { model_version_base: '', seedsText: '42,43,44,45,46' },
    }
  }

  it("e2e 模式 → run_type='train_e2e' + labelRef", () => {
    const out = buildJobPayload(freshForm(), true)
    expect(out.run_type).toBe('train_e2e')
    expect(out.params.factor_version).toBe('v1')
    expect(out.params.new_listing_min_days).toBe(60)
    expect(out.params.date_range).toBe('20260509:20260511')
    expect(out.params.model).toBe('lgb-lambdarank')
    expect(out.params.walk_forward).toBe(true)
    expect(out.params.seed).toBe(42)
    expect(out.labelRef).toEqual({ label_id: 'strategy_label', label_version: 'v1' })
    // label_scheme 不在 params
    expect('label_scheme' in out.params).toBe(false)
  })

  it("e2e 模式关闭 → 走老 train 路径，不输出 train_e2e", () => {
    const f = freshForm()
    f.train.feature_set_id = 'fs-v1-20260517'
    const out = buildJobPayload(f, false)
    expect(out.run_type).toBe('train')
    expect(out.params).toEqual({
      feature_set_id: 'fs-v1-20260517',
      model: 'lgb-lambdarank',
      walk_forward: true,
    })
  })
})
