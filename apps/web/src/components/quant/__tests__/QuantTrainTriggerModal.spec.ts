/**
 * QuantTrainTriggerModal + train-modal/buildParams 单测。
 *
 * 2026-06-06 close_adj 纯后复权改造：
 *  - 删 train_e2e / E2E 模式；训练 modal 改为消费已备 feature_set
 *  - 三类（train/optuna/seed_avg）共享 feature_set_id + date_range
 *  - buildParams 新签名：buildJobPayload(form)（无第二参数）
 *
 * 覆盖：
 *  (1) 默认显示"已备 feature_set"下拉 + date_range（无 E2E 开关）
 *  (2) fs 未选时 canSubmit=false
 *  (3) 选 fs + date_range 后 canSubmit=true（train）
 *  (4) buildParams 输出 run_type='train' + feature_set_id + date_range
 *  (5) optuna / seed_avg 也携带 feature_set_id + date_range
 *  (6) formatDateRange 用本地午夜：new Date(2026, 4, 9) → '20260509'（不漂前/后）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import QuantTrainTriggerModal from '../train/QuantTrainTriggerModal.vue'
import {
  buildJobPayload,
  formatDateRange,
  type TrainTriggerFormShape,
} from '../train/train-modal/buildParams'

// vue-router stub
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
      listFeatureSets: vi.fn().mockResolvedValue([
        {
          feature_set_id: 'fs-v1-20260517',
          factor_version: 'v1',
          scheme: 'default',
          new_listing_min_days: 60,
          label_name: '次日涨跌 h1',
          label_version: '1',
          coverage: [{ start: '20230101', end: '20241231' }],
        },
      ]),
    },
  }
})

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
    selectedFeatureSet: import('@/api/modules/quant').FeatureSet | null
    canSubmit: boolean
    buildParams: () => { run_type: string; params: Record<string, unknown> }
    onSubmit: () => Promise<void>
    isDateDisabledFn: (ts: number) => boolean
  }
}

describe('QuantTrainTriggerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('(1) 无 E2E 开关，改为 feature_set 下拉模式', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()

    // 不应存在"mode-switch"（E2E 开关已删）
    const modeSwitch = wrapper.find('[data-testid="mode-switch"]')
    expect(modeSwitch.exists()).toBe(false)
  })

  it('(2) fs 未选时 canSubmit=false', async () => {
    const wrapper = mountModal()
    await nextTick()
    const vm = getModalVm(wrapper)
    expect(vm.canSubmit).toBe(false)
  })

  it('(3) 选 fs + date_range 后 canSubmit=true（train）', async () => {
    const wrapper = mountModal()
    await nextTick()
    const vm = getModalVm(wrapper)

    vm.form.shared.feature_set_id = 'fs-v1-20260517'
    vm.form.shared.date_range = [new Date(2023, 0, 1).getTime(), new Date(2024, 11, 31).getTime()]
    await nextTick()
    expect(vm.canSubmit).toBe(true)
  })

  it("(4) buildParams 输出 run_type='train' + feature_set_id + date_range", async () => {
    const wrapper = mountModal()
    await nextTick()
    const vm = getModalVm(wrapper)

    vm.form.run_type = 'train'
    vm.form.shared.feature_set_id = 'fs-v1-20260517'
    vm.form.shared.date_range = [new Date(2026, 4, 9).getTime(), new Date(2026, 4, 11).getTime()]
    vm.form.train.model = 'lgb-lambdarank'
    vm.form.train.walk_forward = true
    await nextTick()

    const payload = vm.buildParams()
    expect(payload.run_type).toBe('train')
    expect(payload.params).toMatchObject({
      feature_set_id: 'fs-v1-20260517',
      date_range: '20260509:20260511',
      model: 'lgb-lambdarank',
      walk_forward: true,
    })
    // 新流程无 labelRef / label_ref
    expect('labelRef' in payload).toBe(false)
  })

  it('(5a) optuna 携带 feature_set_id + date_range', async () => {
    const wrapper = mountModal()
    await nextTick()
    const vm = getModalVm(wrapper)

    vm.form.run_type = 'optuna'
    vm.form.shared.feature_set_id = 'fs-v2-20260101'
    vm.form.shared.date_range = [new Date(2026, 0, 1).getTime(), new Date(2026, 5, 30).getTime()]
    await nextTick()

    const payload = vm.buildParams()
    expect(payload.run_type).toBe('optuna')
    expect(payload.params.feature_set_id).toBe('fs-v2-20260101')
    expect(payload.params.date_range).toBe('20260101:20260630')
  })

  it('(5b) seed_avg 携带 feature_set_id + date_range', async () => {
    const wrapper = mountModal()
    await nextTick()
    const vm = getModalVm(wrapper)

    vm.form.run_type = 'seed_avg'
    vm.form.shared.feature_set_id = 'fs-v1-20260517'
    vm.form.shared.date_range = [new Date(2026, 3, 1).getTime(), new Date(2026, 5, 30).getTime()]
    vm.form.seed_avg.model_version_base = 'lgb-lambdarank-v1-20260620'
    await nextTick()

    const payload = vm.buildParams()
    expect(payload.run_type).toBe('seed_avg')
    expect(payload.params.feature_set_id).toBe('fs-v1-20260517')
    expect(payload.params.date_range).toBe('20260401:20260630')
    expect(payload.params.model_version_base).toBe('lgb-lambdarank-v1-20260620')
  })

  it('onSubmit 使用 feature_set_id 不再传 label_ref', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()
    const vm = getModalVm(wrapper)

    vm.form.run_type = 'train'
    vm.form.shared.feature_set_id = 'fs-v1-20260517'
    vm.form.shared.date_range = [new Date(2026, 4, 1).getTime(), new Date(2026, 4, 31).getTime()]
    vm.form.train.model = 'lgb-lambdarank'
    await nextTick()
    expect(vm.canSubmit).toBe(true)

    await vm.onSubmit()
    await flushPromises()

    const { quantApi } = await import('@/api/modules/quant')
    const createJobMock = quantApi.createJob as unknown as ReturnType<typeof vi.fn>
    expect(createJobMock).toHaveBeenCalledTimes(1)
    const body = createJobMock.mock.calls[0][0] as Record<string, unknown>
    expect(body.run_type).toBe('train')
    // 新流程不再传 label_ref
    expect('label_ref' in body).toBe(false)
    expect((body.params as Record<string, unknown>).feature_set_id).toBe('fs-v1-20260517')
    // M2 草稿态：触发入口默认建草稿，as_draft=true
    expect(body.as_draft).toBe(true)
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
      shared: {
        feature_set_id: 'fs-v1-20260517',
        date_range: [new Date(2026, 4, 9).getTime(), new Date(2026, 4, 11).getTime()],
      },
      train: { model: 'lgb-lambdarank', walk_forward: true, seed: null },
      optuna: { n_trials: 50, space: 'lgb-4knobs' },
      seed_avg: { model_version_base: '', seedsText: '42,43,44,45,46' },
    }
  }

  it("train → run_type='train' + feature_set_id + date_range", () => {
    const out = buildJobPayload(freshForm())
    expect(out.run_type).toBe('train')
    expect(out.params.feature_set_id).toBe('fs-v1-20260517')
    expect(out.params.date_range).toBe('20260509:20260511')
    expect(out.params.model).toBe('lgb-lambdarank')
    expect(out.params.walk_forward).toBe(true)
  })

  it("optuna → run_type='optuna' + feature_set_id + date_range", () => {
    const f = freshForm()
    f.run_type = 'optuna'
    const out = buildJobPayload(f)
    expect(out.run_type).toBe('optuna')
    expect(out.params.feature_set_id).toBe('fs-v1-20260517')
    expect(out.params.date_range).toBe('20260509:20260511')
    expect(out.params.n_trials).toBe(50)
    expect(out.params.space).toBe('lgb-4knobs')
  })

  it("seed_avg → run_type='seed_avg' + feature_set_id + date_range", () => {
    const f = freshForm()
    f.run_type = 'seed_avg'
    f.seed_avg.model_version_base = 'lgb-v1-20260620'
    const out = buildJobPayload(f)
    expect(out.run_type).toBe('seed_avg')
    expect(out.params.feature_set_id).toBe('fs-v1-20260517')
    expect(out.params.date_range).toBe('20260509:20260511')
    expect(out.params.model_version_base).toBe('lgb-v1-20260620')
    expect(Array.isArray(out.params.seeds)).toBe(true)
  })

  it('无 train_e2e run_type 输出', () => {
    const out = buildJobPayload(freshForm())
    expect(out.run_type).not.toBe('train_e2e')
  })
})
