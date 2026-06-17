/**
 * useOneClickSync 适配层单测 —— 守「步骤名空标题」回归。
 *
 * 背景：后端持久化的 step 对象**不带 label**（apps/server/.../one-click-sync/types.ts 的
 * OneClickStepState 无此字段），但 API 模块把 steps 标成带 label 的前端类型 —— 这是个 type-check
 * 抓不住的「类型谎言」，曾让步骤行/summary 只渲染「1.」「2.」无步骤名。适配层须按 step key 用
 * 静态 STEP_LABELS 补全。本测用「无 label」的 step 复现后端真实 payload，锁住补全行为，
 * 防有人把 steps 适配回 `() => store.steps` 让 bug 复活。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useOneClickSync } from '../useOneClickSync'
import { STEP_LABELS, type OneClickStepKey, type OneClickStepState } from '../oneClickSync.types'
import { useOneClickSyncStore } from '../../../stores/oneClickSync'
import type { OneClickSyncRun } from '../../../api/modules/market/one-click-sync'

const messageStub = { error: () => {}, success: () => {} }

/** 模拟后端真实下发的 step：刻意省略 label（复现 type 撒谎处 → 运行时 undefined）。 */
function backendStep(step: OneClickStepKey, over: Partial<OneClickStepState> = {}): OneClickStepState {
  return {
    step,
    status: 'pending',
    percent: 0,
    phase: '',
    message: '',
    rowsWritten: 0,
    errors: [],
    startedAt: null,
    finishedAt: null,
    ...over,
  } as unknown as OneClickStepState
}

function makeRun(steps: OneClickStepState[], over: Partial<OneClickSyncRun> = {}): OneClickSyncRun {
  return {
    id: 'r1',
    status: 'running',
    startDate: '20260601',
    endDate: '20260601',
    progress: 0,
    currentStep: 0,
    steps,
    logs: [],
    errorText: null,
    cancelRequested: false,
    createdBy: null,
    startedAt: '2026-06-16 03:00:00Z',
    updatedAt: '2026-06-16 03:00:00Z',
    finishedAt: null,
    ...over,
  }
}

describe('useOneClickSync 适配层 label 合并', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('steps：后端无 label 的 step 被 STEP_LABELS 按 key 补全步骤名', () => {
    const store = useOneClickSyncStore()
    store.currentRun = makeRun([backendStep('base-data'), backendStep('oamv')])
    const ctrl = useOneClickSync(messageStub)
    expect(ctrl.steps.value.map(s => s.label)).toEqual([
      STEP_LABELS['base-data'],
      STEP_LABELS['oamv'],
    ])
  })

  it('summary：终态 run 的步骤列表同样带步骤名（防 summary 空名回归）', () => {
    const store = useOneClickSyncStore()
    store.currentRun = makeRun([backendStep('a-shares', { status: 'success' })], {
      status: 'success',
    })
    const ctrl = useOneClickSync(messageStub)
    expect(ctrl.summary.value?.steps[0].label).toBe(STEP_LABELS['a-shares'])
  })
})
