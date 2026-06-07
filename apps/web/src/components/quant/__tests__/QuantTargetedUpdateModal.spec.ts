/**
 * QuantTargetedUpdateModal（因子/标签定向更新）单测。
 *
 * 对应 spec §8 校验与约束
 * （docs/superpowers/specs/2026-06-06-quant-targeted-factor-label-update-design.md）：
 *  (1) 因子和标签都没选 → validationError + canSubmit=false + onSubmit 不发请求。
 *  (2) 只选因子 → 只发 1 条 factors job：body 含**非空** factor_ids、正确 date_range、version，
 *      且不含 label_ref。
 *  (3) 只选标签 → 只发 1 条 labels job：顶层 label_ref，params 含 date_range，
 *      **不含 scheme**，不含 factor_ids。
 *  (4) 因子 + 标签都选 → 发 2 条请求（factors 在前、labels 在后）。
 *  (5) 日期：[本地午夜 ms] 正确转 'YYYYMMDD:YYYYMMDD'，CST 下不漂前/后
 *      （Modal 复用 train-modal/buildParams::formatDateRange，getFullYear/getMonth/getDate）。
 *  (6) factor_ids 绝不发空数组（空数组会被 Python run_factors 当"全量 16 因子"）。
 *
 * 约定参照同目录 QuantTrainTriggerModal.spec.ts：mock vue-router + @/api/modules/quant，
 * 用 NConfigProvider + NMessageProvider 包裹，断言 createJob 入参（wire payload）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NConfigProvider, NMessageProvider } from 'naive-ui'

import QuantTargetedUpdateModal from '../targeted-update/QuantTargetedUpdateModal.vue'

// vue-router stub：onSubmit 末尾 router.push 不应真跳转
vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
}))

// quantApi stub：避免真发请求；子组件 onMounted 会拉 listFactors/listFactorVersions/listLabels
vi.mock('@/api/modules/quant', async () => {
  const actual = await vi.importActual<typeof import('@/api/modules/quant')>(
    '@/api/modules/quant',
  )
  return {
    ...actual,
    quantApi: {
      createJob: vi.fn().mockResolvedValue({ id: 'job-abc-12345678' }),
      listFactors: vi.fn().mockResolvedValue({
        items: [
          { factor_id: 'mom_20', description: '20日动量', display_order: 1 },
          { factor_id: 'rsi_14', description: 'RSI 14', display_order: 2 },
        ],
      }),
      listFactorVersions: vi.fn().mockResolvedValue({ versions: ['v1', 'v2'] }),
      listLabels: vi.fn().mockResolvedValue({
        items: [
          {
            label_id: 'lbl_fwd5',
            label_version: 'v2',
            name: 'fwd_ret h5',
            base_type: 'fwd_ret',
            base_params: { horizon: 5 },
            classify_mode: 'tercile',
          },
        ],
      }),
    },
  }
})

function mountModal() {
  const Wrapper = defineComponent({
    components: { NConfigProvider, NMessageProvider, QuantTargetedUpdateModal },
    setup() {
      return () =>
        h(NConfigProvider, null, {
          default: () =>
            h(NMessageProvider, null, {
              default: () => h(QuantTargetedUpdateModal, { show: true }),
            }),
        })
    },
  })
  return mount(Wrapper, { attachTo: document.body })
}

interface ModalVm {
  dateRange: [number, number] | null
  factorIds: string[]
  factorVersion: string
  labelKey: string | null
  canSubmit: boolean
  validationError: string | null
  errorText: string
  onSubmit: () => Promise<void>
}

function getInner(wrapper: ReturnType<typeof mountModal>) {
  const inner = wrapper.findComponent(QuantTargetedUpdateModal)
  expect(inner.exists()).toBe(true)
  return inner
}

function getModalVm(wrapper: ReturnType<typeof mountModal>): ModalVm {
  return getInner(wrapper).vm as unknown as ModalVm
}

async function getCreateJobMock() {
  const { quantApi } = await import('@/api/modules/quant')
  return quantApi.createJob as unknown as ReturnType<typeof vi.fn>
}

// 选定 2026-05-09 ~ 2026-05-11（本地午夜 ms），期望转成 '20260509:20260511'
const MAY_09 = new Date(2026, 4, 9).getTime()
const MAY_11 = new Date(2026, 4, 11).getTime()
const EXPECTED_RANGE = '20260509:20260511'

describe('QuantTargetedUpdateModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('(1) 因子和标签都没选 → validationError + canSubmit=false + 不发请求', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()
    const vm = getModalVm(wrapper)

    // 即便日期已选，没选任何因子/标签也不能提交
    vm.dateRange = [MAY_09, MAY_11]
    await nextTick()

    expect(vm.validationError).toBe('请至少选择一个因子或一个标签')
    expect(vm.canSubmit).toBe(false)

    await vm.onSubmit()
    await flushPromises()
    const createJob = await getCreateJobMock()
    expect(createJob).not.toHaveBeenCalled()
  })

  it('(1b) 没选日期 → validationError 提示选日期 + canSubmit=false', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()
    const vm = getModalVm(wrapper)

    vm.factorIds = ['mom_20']
    vm.dateRange = null
    await nextTick()

    expect(vm.validationError).toBe('请选择日期范围')
    expect(vm.canSubmit).toBe(false)
  })

  it('(2) 只选因子 → 只发 1 条 factors job（非空 factor_ids + date_range + version）', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()
    const vm = getModalVm(wrapper)

    vm.dateRange = [MAY_09, MAY_11]
    vm.factorIds = ['mom_20', 'rsi_14']
    vm.factorVersion = 'v1'
    await nextTick()
    expect(vm.canSubmit).toBe(true)

    await vm.onSubmit()
    await flushPromises()

    const createJob = await getCreateJobMock()
    expect(createJob).toHaveBeenCalledTimes(1)
    const body = createJob.mock.calls[0][0] as Record<string, unknown>
    expect(body.run_type).toBe('factors')
    expect('label_ref' in body).toBe(false)

    const params = body.params as Record<string, unknown>
    expect(params.factor_ids).toEqual(['mom_20', 'rsi_14'])
    expect((params.factor_ids as string[]).length).toBeGreaterThan(0)
    expect(params.date_range).toBe(EXPECTED_RANGE)
    expect(params.version).toBe('v1')
  })

  it('(3) 只选标签 → 只发 1 条 labels job（顶层 label_ref + date_range，不含 scheme/factor_ids）', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()
    const vm = getModalVm(wrapper)

    vm.dateRange = [MAY_09, MAY_11]
    vm.labelKey = 'lbl_fwd5:v2'
    await nextTick()
    expect(vm.canSubmit).toBe(true)

    await vm.onSubmit()
    await flushPromises()

    const createJob = await getCreateJobMock()
    expect(createJob).toHaveBeenCalledTimes(1)
    const body = createJob.mock.calls[0][0] as Record<string, unknown>
    expect(body.run_type).toBe('labels')
    // label_ref 是顶层字段（对齐后端 DTO），由 "label_id:label_version" 拆出
    expect(body.label_ref).toEqual({ label_id: 'lbl_fwd5', label_version: 'v2' })

    const params = body.params as Record<string, unknown>
    expect(params.date_range).toBe(EXPECTED_RANGE)
    // labels 入口走 label_ref，前端绝不自己拼 scheme；也不应混入 factor_ids
    expect('scheme' in params).toBe(false)
    expect('factor_ids' in params).toBe(false)
  })

  it('(4) 因子 + 标签都选 → 发 2 条请求（factors 在前、labels 在后），S1：submitted 透传首个(因子)job', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()
    const vm = getModalVm(wrapper)
    const inner = getInner(wrapper)

    // 两条 job 返回不同 id，断言父组件高亮的是首个（因子）而非最后一个（标签）
    const createJob = await getCreateJobMock()
    createJob
      .mockResolvedValueOnce({ id: 'factors-job-aaaa1111' })
      .mockResolvedValueOnce({ id: 'labels-job-bbbb2222' })

    vm.dateRange = [MAY_09, MAY_11]
    vm.factorIds = ['mom_20']
    vm.factorVersion = 'v1'
    vm.labelKey = 'lbl_fwd5:v2'
    await nextTick()
    expect(vm.canSubmit).toBe(true)

    await vm.onSubmit()
    await flushPromises()

    expect(createJob).toHaveBeenCalledTimes(2)
    expect((createJob.mock.calls[0][0] as Record<string, unknown>).run_type).toBe('factors')
    expect((createJob.mock.calls[1][0] as Record<string, unknown>).run_type).toBe('labels')

    // S1：emit('submitted') 应是首个（因子）job 的 id，而非最后一个（标签）
    const submitted = inner.emitted('submitted') as unknown[][] | undefined
    expect(submitted).toBeTruthy()
    expect(submitted![0][0]).toBe('factors-job-aaaa1111')
  })

  it('(S2) 因子成功落库后标签 job 失败 → errorText 提示因子已提交，不抹掉已发的因子任务', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()
    const vm = getModalVm(wrapper)

    const createJob = await getCreateJobMock()
    // 第 1 条（因子）成功，第 2 条（标签）失败
    createJob
      .mockResolvedValueOnce({ id: 'factors-job-cccc3333' })
      .mockRejectedValueOnce(new Error('worker 拒绝'))

    vm.dateRange = [MAY_09, MAY_11]
    vm.factorIds = ['mom_20']
    vm.labelKey = 'lbl_fwd5:v2'
    await nextTick()

    await vm.onSubmit()
    await flushPromises()

    // 两条都发起了（因子成功、标签失败）
    expect(createJob).toHaveBeenCalledTimes(2)
    // errorText 如实提示因子已提交 + 失败原因，避免用户重复提交因子
    expect(vm.errorText).toContain('因子任务已提交')
    // 文案带因子 job_id 前 8 位（'factors-job-cccc3333'.slice(0,8) === 'factors-'）
    expect(vm.errorText).toContain('factors-')
    expect(vm.errorText).toContain('worker 拒绝')
  })

  it('(5) 日期本地日历日不漂：选 20260509~20260511 → date_range 字面就是 20260509:20260511', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()
    const vm = getModalVm(wrapper)

    vm.dateRange = [MAY_09, MAY_11]
    vm.factorIds = ['mom_20']
    await nextTick()

    await vm.onSubmit()
    await flushPromises()

    const createJob = await getCreateJobMock()
    const params = (createJob.mock.calls[0][0] as Record<string, unknown>).params as Record<
      string,
      unknown
    >
    expect(params.date_range).toBe(EXPECTED_RANGE)
  })

  it('(6) factor_ids 绝不发空数组：只选标签时不发 factors job，且无任何调用携带空 factor_ids', async () => {
    const wrapper = mountModal()
    await nextTick()
    await flushPromises()
    const vm = getModalVm(wrapper)

    vm.dateRange = [MAY_09, MAY_11]
    vm.factorIds = [] // 显式空
    vm.labelKey = 'lbl_fwd5:v2'
    await nextTick()

    await vm.onSubmit()
    await flushPromises()

    const createJob = await getCreateJobMock()
    // 只有 labels 一条，没有 factors job
    expect(createJob).toHaveBeenCalledTimes(1)
    for (const call of createJob.mock.calls) {
      const body = call[0] as Record<string, unknown>
      expect(body.run_type).not.toBe('factors')
      const params = (body.params ?? {}) as Record<string, unknown>
      // 任何调用都不得携带空数组的 factor_ids
      if ('factor_ids' in params) {
        expect((params.factor_ids as string[]).length).toBeGreaterThan(0)
      }
    }
  })
})
