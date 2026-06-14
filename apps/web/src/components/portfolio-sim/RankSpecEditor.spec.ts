/**
 * RankSpecEditor 单测：多因子排序编辑器的增删 + none/单/composite emit 结构。
 *
 * 覆盖 spec 07 §单测要点：
 *  - 增因子 → emit update:factors，长度 +1、新因子带默认权重/方向
 *  - 删因子 → 长度 -1
 *  - none（[]）→ 单因子 → composite 的 emit 结构正确
 *  - 切因子 → 方向重置为该因子默认 dir
 *  - 含 ml_score（histAvailable=false）→ 显前向专用警示
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { NButton, NSelect } from 'naive-ui'
import RankSpecEditor from './RankSpecEditor.vue'
import type { RankFactor } from '../../api/modules/strategy/portfolioSim'

function mountEditor(factors: RankFactor[]) {
  return mount(RankSpecEditor, { props: { factors, disabled: false } })
}

/** 取最后一次 update:factors 的 payload（emit 的第一个参数）。 */
function lastFactors(w: ReturnType<typeof mountEditor>): RankFactor[] | undefined {
  const emitted = w.emitted('update:factors') as unknown[][] | undefined
  if (!emitted || emitted.length === 0) return undefined
  return emitted[emitted.length - 1][0] as RankFactor[]
}

describe('RankSpecEditor 增删因子', () => {
  it('空数组 → 显「none」提示，无因子行', () => {
    const w = mountEditor([])
    expect(w.text()).toContain('none')
    expect(w.text()).toContain('不排序')
  })

  it('加因子（none → 单因子）→ emit 长度 1，带 weight=1 + 合法 dir', () => {
    const w = mountEditor([])
    // 「+ 加因子」按钮是最后一个 NButton（行内删除按钮在有行时才出现，这里 none 无行）
    const addBtn = w.findAllComponents(NButton).at(-1)!
    addBtn.vm.$emit('click')
    const f = lastFactors(w)
    expect(f).toBeTruthy()
    expect(f!.length).toBe(1)
    expect(f![0].weight).toBe(1)
    expect(['asc', 'desc']).toContain(f![0].dir)
    expect(typeof f![0].factor).toBe('string')
  })

  it('加因子（单 → composite）→ emit 长度 2，第二个因子 KEY 与首个不同', () => {
    const w = mountEditor([{ factor: 'pos_120', weight: 1, dir: 'asc' }])
    const addBtn = w.findAllComponents(NButton).at(-1)!
    addBtn.vm.$emit('click')
    const f = lastFactors(w)
    expect(f!.length).toBe(2)
    expect(f![0].factor).toBe('pos_120')
    // nextUnusedFactor 应避开已用的 pos_120
    expect(f![1].factor).not.toBe('pos_120')
  })

  it('删因子（composite → 单）→ emit 长度 1，保留另一因子', () => {
    const w = mountEditor([
      { factor: 'pos_120', weight: 1, dir: 'asc' },
      { factor: 'circ_mv', weight: 0.5, dir: 'asc' },
    ])
    // 行内「−」删除按钮：每行一个 NButton，删第 0 行
    const removeBtns = w.findAllComponents(NButton).filter((b) => b.text() === '−')
    expect(removeBtns.length).toBe(2)
    removeBtns[0].vm.$emit('click')
    const f = lastFactors(w)
    expect(f!.length).toBe(1)
    expect(f![0].factor).toBe('circ_mv')
  })
})

describe('RankSpecEditor 切因子方向重置', () => {
  it('切到 risk_reward（默认 desc）→ dir 重置为 desc', async () => {
    const w = mountEditor([{ factor: 'pos_120', weight: 1, dir: 'asc' }])
    // 第一个 NSelect = 因子下拉
    const factorSelect = w.findAllComponents(NSelect)[0]
    factorSelect.vm.$emit('update:value', 'risk_reward')
    await w.vm.$nextTick()
    const f = lastFactors(w)
    expect(f![0].factor).toBe('risk_reward')
    expect(f![0].dir).toBe('desc')
  })
})

describe('RankSpecEditor 前向专用警示', () => {
  it('含 ml_score → 显「前向」警示文案', () => {
    const w = mountEditor([{ factor: 'ml_score', weight: 1, dir: 'desc' }])
    expect(w.text()).toContain('前向')
  })

  it('不含前向专用因子 → 无警示', () => {
    const w = mountEditor([{ factor: 'pos_120', weight: 1, dir: 'asc' }])
    expect(w.text()).not.toContain('仅前向有效')
  })
})
