import { describe, it, expect } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useSignalTestForm } from './useSignalTestForm'
import type { SignalTest } from '@/api/modules/strategy/signalStats'

/**
 * 在组件 setup 内启动 composable（watch immediate + 可变 form），暴露给测试操作。
 */
function setup(initial?: SignalTest, prefill?: SignalTest) {
  const captured: { api?: ReturnType<typeof useSignalTestForm> } = {}
  const initialRef = ref<SignalTest | undefined>(initial)
  const prefillRef = ref<SignalTest | undefined>(prefill)
  const Wrapper = defineComponent({
    setup() {
      captured.api = useSignalTestForm(
        { get value() { return initialRef.value } },
        { get value() { return prefillRef.value } },
      )
      return () => h('div')
    },
  })
  const wrapper = mount(Wrapper)
  return { api: captured.api!, wrapper }
}

const BASE_DATE_RANGE: [number, number] = [
  new Date(2024, 0, 1).getTime(),
  new Date(2026, 0, 1).getTime(),
]

describe('useSignalTestForm DTO 组装', () => {
  it('默认 fixed_n + 不启用回测 → backtestConfig 为 null，无出场专属字段', () => {
    const { api } = setup()
    api.form.value.name = 'T1'
    api.form.value.buyConditions = [{ field: 'close', operator: 'gt', value: 1 } as never]
    api.form.value.dateRange = BASE_DATE_RANGE
    const dto = api.buildDto()
    expect(dto.exitMode).toBe('fixed_n')
    expect(dto.horizonN).toBe(5)
    expect(dto.backtestConfig).toBeNull()
    expect(dto.dateStart).toBe('20240101')
    expect(dto.dateEnd).toBe('20260101')
  })

  it('启用回测 → 组装完整合法 backtestConfig（rankSpec/sizing/circuitBreaker 齐全）', () => {
    const { api } = setup()
    api.form.value.name = 'T2'
    api.form.value.buyConditions = [{ field: 'close', operator: 'gt', value: 1 } as never]
    api.form.value.dateRange = BASE_DATE_RANGE
    api.form.value.enableBacktest = true
    const dto = api.buildDto()
    expect(dto.backtestConfig).not.toBeNull()
    const bc = dto.backtestConfig!
    expect(bc.initialCapital).toBeGreaterThan(0)
    expect(bc.positionRatio).toBeGreaterThan(0)
    expect(bc.positionRatio).toBeLessThanOrEqual(1)
    expect(bc.cost).toBeTruthy()
    expect(typeof bc.anchorMode).toBe('boolean')
    expect(Array.isArray(bc.rankSpec.factors)).toBe(true)
    expect(bc.sizing).toBeTruthy()
    expect(bc.sizing.mode).toBe('fixed')
    // 双闸全关 → circuitBreaker 提交 null（与后端「null=全关」对齐）
    expect(bc.circuitBreaker).toBeNull()
  })

  it('启用回测 + 开启连亏熔断 → circuitBreaker 非 null 下发', () => {
    const { api } = setup()
    api.form.value.name = 'T3'
    api.form.value.buyConditions = [{ field: 'close', operator: 'gt', value: 1 } as never]
    api.form.value.dateRange = BASE_DATE_RANGE
    api.form.value.enableBacktest = true
    api.form.value.btCircuitBreaker.enableCooldown = true
    const dto = api.buildDto()
    expect(dto.backtestConfig!.circuitBreaker).not.toBeNull()
    expect(dto.backtestConfig!.circuitBreaker!.enableCooldown).toBe(true)
  })

  it('trailing_lock 全默认 → 不上送 4 个专属字段（零漂移）', async () => {
    const { api } = setup()
    api.form.value.name = 'T4'
    api.form.value.buyConditions = [{ field: 'close', operator: 'gt', value: 1 } as never]
    api.form.value.dateRange = BASE_DATE_RANGE
    api.form.value.exitMode = 'trailing_lock'
    await nextTick()
    const dto = api.buildDto()
    expect(dto.stopRatio).toBeUndefined()
    expect(dto.floorRatio).toBeUndefined()
    expect(dto.floorEnabled).toBeUndefined()
    expect(dto.ma5RequireDown).toBeUndefined()
    // 切到 trailing_lock 后 maxHold 复位为 null（不封顶）
    expect(dto.maxHold).toBeUndefined()
  })

  it('trailing_lock 改 stopRatio → 仅上送被改字段', async () => {
    const { api } = setup()
    api.form.value.name = 'T5'
    api.form.value.buyConditions = [{ field: 'close', operator: 'gt', value: 1 } as never]
    api.form.value.dateRange = BASE_DATE_RANGE
    api.form.value.exitMode = 'trailing_lock'
    await nextTick()
    api.form.value.stopRatio = 0.99
    const dto = api.buildDto()
    expect(dto.stopRatio).toBe(0.99)
    expect(dto.floorRatio).toBeUndefined()
  })

  it('phase_lock lookback 非默认 → 上送 lookback（仍属 phase_lock_params）', async () => {
    const { api } = setup()
    api.form.value.name = 'T6'
    api.form.value.buyConditions = [{ field: 'close', operator: 'gt', value: 1 } as never]
    api.form.value.dateRange = BASE_DATE_RANGE
    api.form.value.exitMode = 'phase_lock'
    await nextTick()
    api.form.value.lookback = 20
    const dto = api.buildDto()
    expect(dto.lookback).toBe(20)
    // 默认 initFactor/lockFactor 不上送
    expect(dto.initFactor).toBeUndefined()
    expect(dto.lockFactor).toBeUndefined()
  })

  it('phase_lock lookback 默认 10 → 不上送（零漂移）', async () => {
    const { api } = setup()
    api.form.value.name = 'T7'
    api.form.value.buyConditions = [{ field: 'close', operator: 'gt', value: 1 } as never]
    api.form.value.dateRange = BASE_DATE_RANGE
    api.form.value.exitMode = 'phase_lock'
    await nextTick()
    const dto = api.buildDto()
    expect(dto.lookback).toBeUndefined()
  })

  it('编辑回填带 backtestConfig → enableBacktest=true 且字段回填', () => {
    const edit: SignalTest = {
      id: 'x',
      name: '回填方案',
      buyConditions: [{ field: 'close', operator: 'gt', value: 1 } as never],
      exitMode: 'fixed_n',
      horizonN: 7,
      exitConditions: null,
      maxHold: null,
      bandLockParams: null,
      phaseLockParams: null,
      backtestConfig: {
        initialCapital: 500000,
        cost: {
          commissionPerSide: 0,
          transferPerSide: 0,
          stampSellBefore20230828: 0,
          stampSellFrom20230828: 0,
          slippagePerSide: 0,
        },
        anchorMode: true,
        positionRatio: 0.2,
        maxPositions: 5,
        exposureCap: 0.8,
        rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'asc' }] },
        sizing: {
          mode: 'fixed',
          floorMult: 0.5,
          capMult: 1.5,
          kellyFraction: 0.5,
          kellyMaxMult: 1,
        },
        circuitBreaker: null,
      },
      universe: { type: 'all' },
      dateStart: '20240101',
      dateEnd: '20260101',
      createdAt: '',
      updatedAt: '',
    }
    const { api } = setup(edit)
    expect(api.form.value.enableBacktest).toBe(true)
    expect(api.form.value.btInitialCapital).toBe(500000)
    expect(api.form.value.btAnchorMode).toBe(true)
    expect(api.form.value.btPositionRatio).toBe(0.2)
    expect(api.form.value.btRankFactors).toHaveLength(1)
    const dto = api.buildDto()
    expect(dto.backtestConfig!.positionRatio).toBe(0.2)
    expect(dto.backtestConfig!.rankSpec.factors).toHaveLength(1)
  })

  it('编辑回填 backtestConfig=null → enableBacktest=false，提交回 null', () => {
    const edit: SignalTest = {
      id: 'y',
      name: '旧方案',
      buyConditions: [{ field: 'close', operator: 'gt', value: 1 } as never],
      exitMode: 'fixed_n',
      horizonN: 5,
      exitConditions: null,
      maxHold: null,
      bandLockParams: null,
      phaseLockParams: null,
      backtestConfig: null,
      universe: { type: 'all' },
      dateStart: '20240101',
      dateEnd: '20260101',
      createdAt: '',
      updatedAt: '',
    }
    const { api } = setup(edit)
    expect(api.form.value.enableBacktest).toBe(false)
    expect(api.buildDto().backtestConfig).toBeNull()
  })
})
