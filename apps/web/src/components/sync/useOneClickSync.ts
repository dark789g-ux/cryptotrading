import { computed, ref, watch, type Ref } from 'vue'
import { useASharesSync } from '@/components/symbols/a-shares/useASharesSync'
import { useMoneyFlowSync } from './useMoneyFlowSync'
import { useThsIndexDailySync } from './useThsIndexDailySync'
import { useOamvSync } from './useOamvSync'
import { useActiveMvSync } from './useActiveMvSync'
import {
  LOG_LIMIT,
  buildInitialSteps,
  toYYYYMMDD,
  type LogEntry,
  type OneClickErrorItem,
  type OneClickMessageApi,
  type OneClickStepKey,
  type OneClickStepStatus,
  type OneClickStepState,
  type OneClickSummary,
} from './oneClickSync.types'

export type {
  LogEntry,
  OneClickErrorItem,
  OneClickStepKey,
  OneClickStepStatus,
  OneClickStepState,
  OneClickSummary,
} from './oneClickSync.types'

export function useOneClickSync(message: OneClickMessageApi) {
  // ---- 状态 ----
  const dateRange = ref<[number, number] | null>(null)
  const running = ref(false)
  const cancelled = ref(false)
  const steps = ref<OneClickStepState[]>(buildInitialSteps())
  const currentStepIndex = ref(-1)
  const elapsedMs = ref(0)
  const logEntries = ref<LogEntry[]>([])
  const summary = ref<OneClickSummary | null>(null)
  const startedAt = ref<number | null>(null)

  // 适配 A 股 composable 的 message（不弹 toast，仅记日志，由顶部汇总弹）
  function adaptMessage(base: OneClickMessageApi): OneClickMessageApi {
    return {
      success: (msg: string) => {
        pushLog({ step: 'a-shares', level: 'info', text: msg })
      },
      error: (msg: string) => {
        pushLog({ step: 'a-shares', level: 'error', text: msg })
        base.error?.(msg)
      },
    }
  }

  // ---- 底层 composable 实例化 ----
  const noopReload = async () => {}
  const aSharesCtrl = useASharesSync(adaptMessage(message), noopReload)
  const moneyFlowCtrl = useMoneyFlowSync(message)
  const thsIndexCtrl = useThsIndexDailySync(message)
  const oamvCtrl = useOamvSync(message)
  // 三类 AMV 共用一个 composable 实例（普通 POST，无 SSE）
  const activeMvCtrl = useActiveMvSync(message)

  // ---- computed ----
  const totalPercent = computed(() => {
    const arr = steps.value
    let acc = 0
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i]
      if (s.status === 'success' || s.status === 'failed' || s.status === 'skipped') {
        acc += 100
      } else if (s.status === 'running') {
        acc += Math.max(0, Math.min(100, s.percent))
      }
    }
    return Math.round(acc / arr.length)
  })

  const canStart = computed(
    () => !running.value && !!dateRange.value && !!dateRange.value[0] && !!dateRange.value[1],
  )

  // ---- 日志 / 状态工具 ----
  function pushLog(entry: Omit<LogEntry, 'ts'>) {
    const e: LogEntry = { ts: Date.now(), ...entry }
    logEntries.value.push(e)
    if (logEntries.value.length > LOG_LIMIT) {
      logEntries.value.splice(0, logEntries.value.length - LOG_LIMIT)
    }
  }

  function resetSteps() {
    steps.value = buildInitialSteps()
    currentStepIndex.value = -1
    elapsedMs.value = 0
    logEntries.value = []
    summary.value = null
    startedAt.value = null
    cancelled.value = false
  }

  function setStepStatus(i: number, status: OneClickStepStatus) {
    const s = steps.value[i]
    if (!s) return
    s.status = status
    if (status === 'running' && s.startedAt === null) s.startedAt = Date.now()
    if (
      (status === 'success' || status === 'failed' || status === 'skipped') &&
      s.finishedAt === null
    ) {
      s.finishedAt = Date.now()
    }
  }

  // ---- 计时器 ----
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  function startElapsed() {
    startedAt.value = Date.now()
    elapsedMs.value = 0
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = setInterval(() => {
      if (startedAt.value !== null) elapsedMs.value = Date.now() - startedAt.value
    }, 250)
  }
  function stopElapsed() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    if (startedAt.value !== null) elapsedMs.value = Date.now() - startedAt.value
  }

  // ---- SSE watcher（适用于 a-shares / money-flow / ths-index-daily） ----
  function installSseWatcher(
    stepIndex: number,
    stepKey: OneClickStepKey,
    syncPhase: Ref<string>,
    syncPercent: Ref<number>,
    syncStatus: Ref<'idle' | 'running' | 'done' | 'error'>,
    syncMessage: Ref<string>,
  ): () => void {
    let lastMsg = ''
    return watch(
      [syncPhase, syncPercent, syncStatus, syncMessage],
      ([phase, pct, st, msg]) => {
        const s = steps.value[stepIndex]
        if (!s) return
        s.phase = phase || s.phase
        s.percent = Math.max(0, Math.min(100, Math.round(pct || 0)))
        if (st === 'running' && s.status !== 'running') setStepStatus(stepIndex, 'running')
        s.message = msg || s.message
        if (msg && msg !== lastMsg) {
          lastMsg = msg
          pushLog({ step: stepKey, level: 'info', text: `${phase ? `[${phase}] ` : ''}${msg}` })
        }
      },
      { immediate: false },
    )
  }

  // ---- 等待 finished ref（moneyflow / thsIndex） ----
  function awaitFinished<T>(
    finished: Ref<T | null>,
    syncStatus: Ref<'idle' | 'running' | 'done' | 'error'>,
  ): Promise<{ ok: boolean; result: T | null }> {
    return new Promise(resolve => {
      const stop = watch(
        [finished, syncStatus, cancelled],
        ([f, st, cancel]) => {
          if (f !== null) {
            stop()
            resolve({ ok: true, result: f as T })
          } else if (st === 'error') {
            stop()
            resolve({ ok: false, result: null })
          } else if (cancel) {
            stop()
            resolve({ ok: false, result: null })
          }
        },
        { immediate: true },
      )
    })
  }

  // ---- A 股完成判定（方案 1：watch syncStatus → 'done'/'error'） ----
  function awaitASharesDone(): Promise<'done' | 'error'> {
    return new Promise(resolve => {
      const stop = watch(
        [aSharesCtrl.syncStatus, cancelled],
        ([st, cancel]) => {
          if (st === 'done') {
            stop()
            resolve('done')
          } else if (st === 'error' || cancel) {
            stop()
            resolve('error')
          }
        },
        { immediate: true },
      )
    })
  }

  // ---- 4 步骤执行 ----
  async function runAShares() {
    const i = 0
    const key: OneClickStepKey = 'a-shares'
    currentStepIndex.value = i
    setStepStatus(i, 'running')
    pushLog({ step: key, level: 'info', text: '开始 A 股数据同步' })

    const stopWatcher = installSseWatcher(
      i,
      key,
      aSharesCtrl.syncPhase,
      aSharesCtrl.syncPercent,
      aSharesCtrl.syncStatus,
      aSharesCtrl.syncMessage,
    )

    try {
      aSharesCtrl.syncDateRange.value = dateRange.value
      aSharesCtrl.syncMode.value = 'incremental'
      void aSharesCtrl.syncAShares()
      const final = await awaitASharesDone()
      if (final === 'done') {
        const finalMsg = aSharesCtrl.syncMessage.value
        steps.value[i].message = finalMsg || steps.value[i].message
        steps.value[i].percent = 100
        setStepStatus(i, 'success')
        pushLog({ step: key, level: 'info', text: `完成：${finalMsg || '同步成功'}` })
      } else {
        setStepStatus(i, 'failed')
        const err: OneClickErrorItem = {
          step: key,
          level: 'error',
          message: aSharesCtrl.syncMessage.value || 'A 股同步失败',
        }
        steps.value[i].errors.push(err)
        pushLog({ step: key, level: 'error', text: err.message })
      }
    } catch (e: unknown) {
      setStepStatus(i, 'failed')
      const msg = e instanceof Error ? e.message : String(e)
      steps.value[i].errors.push({ step: key, level: 'error', message: msg })
      pushLog({ step: key, level: 'error', text: msg })
    } finally {
      stopWatcher()
    }
  }

  async function runMoneyFlow() {
    const i = 1
    const key: OneClickStepKey = 'money-flow'
    currentStepIndex.value = i
    setStepStatus(i, 'running')
    pushLog({ step: key, level: 'info', text: '开始资金流向同步' })

    const stopWatcher = installSseWatcher(
      i,
      key,
      moneyFlowCtrl.sse.phase,
      moneyFlowCtrl.sse.percent,
      moneyFlowCtrl.sse.status,
      moneyFlowCtrl.sse.message,
    )

    try {
      moneyFlowCtrl.syncDateRange.value = dateRange.value
      moneyFlowCtrl.syncMode.value = 'incremental'
      void moneyFlowCtrl.confirmSync()
      const { ok, result } = await awaitFinished(moneyFlowCtrl.finished, moneyFlowCtrl.sse.status)
      if (ok && result) {
        const errs = result.errors ?? []
        let rows = 0
        const summaryObj = result.summary
        if (summaryObj && typeof summaryObj === 'object') {
          for (const v of Object.values(summaryObj)) {
            const sNum = (v as { success?: number } | null)?.success
            if (typeof sNum === 'number') rows += sNum
          }
        }
        steps.value[i].rowsWritten = rows
        if (errs.length > 0) {
          for (const e of errs) {
            const item: OneClickErrorItem = {
              step: key,
              level: 'warn',
              apiName: e.phase,
              message: typeof e.error === 'string' ? e.error : JSON.stringify(e.error),
            }
            steps.value[i].errors.push(item)
            pushLog({ step: key, level: 'warn', text: `[${item.apiName}] ${item.message}` })
          }
          setStepStatus(i, 'failed')
        } else {
          setStepStatus(i, 'success')
        }
        steps.value[i].percent = 100
      } else {
        setStepStatus(i, 'failed')
        steps.value[i].errors.push({
          step: key,
          level: 'error',
          message: moneyFlowCtrl.sse.message.value || '资金流向同步失败',
        })
      }
    } catch (e: unknown) {
      setStepStatus(i, 'failed')
      const msg = e instanceof Error ? e.message : String(e)
      steps.value[i].errors.push({ step: key, level: 'error', message: msg })
      pushLog({ step: key, level: 'error', text: msg })
    } finally {
      stopWatcher()
    }
  }

  async function runThsIndexDaily() {
    const i = 2
    const key: OneClickStepKey = 'ths-index-daily'
    currentStepIndex.value = i
    setStepStatus(i, 'running')
    pushLog({ step: key, level: 'info', text: '开始指数日线同步' })

    const stopWatcher = installSseWatcher(
      i,
      key,
      thsIndexCtrl.sse.phase,
      thsIndexCtrl.sse.percent,
      thsIndexCtrl.sse.status,
      thsIndexCtrl.sse.message,
    )

    try {
      thsIndexCtrl.syncDateRange.value = dateRange.value
      thsIndexCtrl.syncMode.value = 'incremental'
      void thsIndexCtrl.confirmSync()
      const { ok, result } = await awaitFinished(thsIndexCtrl.finished, thsIndexCtrl.sse.status)
      if (ok && result) {
        const res = result.result
        steps.value[i].rowsWritten = res?.success ?? 0
        const errs = res?.errors ?? []
        if (errs.length > 0) {
          for (const e of errs) {
            const item: OneClickErrorItem = {
              step: key,
              level: 'warn',
              apiName: e.apiName,
              message: e.message ?? JSON.stringify(e.params ?? {}),
            }
            steps.value[i].errors.push(item)
            pushLog({ step: key, level: 'warn', text: `[${item.apiName}] ${item.message}` })
          }
          setStepStatus(i, 'failed')
        } else {
          setStepStatus(i, 'success')
        }
        steps.value[i].percent = 100
      } else {
        setStepStatus(i, 'failed')
        steps.value[i].errors.push({
          step: key,
          level: 'error',
          message: thsIndexCtrl.sse.message.value || '指数日线同步失败',
        })
      }
    } catch (e: unknown) {
      setStepStatus(i, 'failed')
      const msg = e instanceof Error ? e.message : String(e)
      steps.value[i].errors.push({ step: key, level: 'error', message: msg })
      pushLog({ step: key, level: 'error', text: msg })
    } finally {
      stopWatcher()
    }
  }

  // ---- 三类 AMV 步骤（普通 POST，无 SSE，照 runOamv 模板）----
  //
  // 一键同步的三类 AMV 一律 syncMode='incremental'：日增量只算选定日期范围内的
  // 新交易日，量很小，不会撞网关 60s timeout。全量回填（个股 ~4000 只最坏 ~13 分钟）
  // **禁止进一键同步**，请走各自页面（/symbols 个股同步页等）的手动同步。
  async function runAmvStep(
    i: number,
    key: OneClickStepKey,
    phaseLabel: string,
    doSync: () => Promise<{ synced: number } | null>,
  ) {
    currentStepIndex.value = i
    setStepStatus(i, 'running')
    pushLog({ step: key, level: 'info', text: `开始 ${phaseLabel}（增量模式）` })

    try {
      activeMvCtrl.syncDateRange.value = dateRange.value
      activeMvCtrl.syncMode.value = 'incremental'
      steps.value[i].phase = phaseLabel
      steps.value[i].message = '当前为增量模式（全量回填请走各自同步页）'
      steps.value[i].percent = 30
      // AMV sync 是单次 HTTP 调用（无 SSE），内部 await 全程；接住 synced 填写入行数
      const result = await doSync()
      const synced = result?.synced ?? 0
      steps.value[i].rowsWritten = synced
      steps.value[i].percent = 100
      setStepStatus(i, 'success')
      pushLog({ step: key, level: 'info', text: `${phaseLabel} 完成，写入 ${synced} 行` })
    } catch (e: unknown) {
      setStepStatus(i, 'failed')
      const msg = e instanceof Error ? e.message : String(e)
      steps.value[i].errors.push({ step: key, level: 'error', message: msg })
      pushLog({ step: key, level: 'error', text: msg })
    }
  }

  async function runStockAmv() {
    await runAmvStep(3, 'stock-amv', '同步个股 AMV', () => activeMvCtrl.syncStock())
  }

  async function runIndustryAmv() {
    await runAmvStep(4, 'industry-amv', '同步行业指数 AMV', () => activeMvCtrl.syncIndustry())
  }

  async function runConceptAmv() {
    await runAmvStep(5, 'concept-amv', '同步板块（概念）AMV', () => activeMvCtrl.syncConcept())
  }

  async function runOamv() {
    const i = 6
    const key: OneClickStepKey = 'oamv'
    currentStepIndex.value = i
    setStepStatus(i, 'running')
    pushLog({ step: key, level: 'info', text: '开始 0AMV 同步' })

    try {
      oamvCtrl.syncDateRange.value = dateRange.value
      oamvCtrl.syncMode.value = 'incremental'
      steps.value[i].phase = '同步 0AMV'
      steps.value[i].percent = 30
      // oamv 是单次 HTTP 调用（无 SSE），confirmSync 内部 await 全程
      await oamvCtrl.confirmSync()
      steps.value[i].percent = 100
      setStepStatus(i, 'success')
      pushLog({ step: key, level: 'info', text: '0AMV 同步完成' })
    } catch (e: unknown) {
      setStepStatus(i, 'failed')
      const msg = e instanceof Error ? e.message : String(e)
      steps.value[i].errors.push({ step: key, level: 'error', message: msg })
      pushLog({ step: key, level: 'error', text: msg })
    }
  }

  // ---- 编排入口 ----
  async function start(): Promise<void> {
    if (running.value) return
    if (!dateRange.value || !dateRange.value[0] || !dateRange.value[1]) {
      message.error('请先选择日期范围')
      return
    }
    resetSteps()
    running.value = true
    startElapsed()
    pushLog({
      step: 'system',
      level: 'info',
      text: `开始一键同步：${toYYYYMMDD(dateRange.value[0])} ~ ${toYYYYMMDD(dateRange.value[1])}`,
    })

    try {
      await runAShares()
      if (cancelled.value) {
        markRemainingSkipped(1)
        return
      }
      await runMoneyFlow()
      if (cancelled.value) {
        markRemainingSkipped(2)
        return
      }
      await runThsIndexDaily()
      if (cancelled.value) {
        markRemainingSkipped(3)
        return
      }
      await runStockAmv()
      if (cancelled.value) {
        markRemainingSkipped(4)
        return
      }
      await runIndustryAmv()
      if (cancelled.value) {
        markRemainingSkipped(5)
        return
      }
      await runConceptAmv()
      if (cancelled.value) {
        markRemainingSkipped(6)
        return
      }
      await runOamv()
    } finally {
      stopElapsed()
      buildSummary()
      running.value = false
      currentStepIndex.value = -1
    }
  }

  function markRemainingSkipped(fromIndex: number) {
    for (let i = fromIndex; i < steps.value.length; i++) {
      if (steps.value[i].status === 'pending') setStepStatus(i, 'skipped')
    }
  }

  function buildSummary() {
    const allErrors: OneClickErrorItem[] = []
    for (const s of steps.value) allErrors.push(...s.errors)
    summary.value = {
      steps: steps.value.map(s => ({ ...s, errors: [...s.errors] })),
      totalMs: elapsedMs.value,
      errors: allErrors,
      cancelled: cancelled.value,
    }
    const failedCount = steps.value.filter(s => s.status === 'failed').length
    if (cancelled.value) {
      pushLog({ step: 'system', level: 'warn', text: '一键同步已取消' })
    } else if (failedCount > 0) {
      pushLog({
        step: 'system',
        level: 'warn',
        text: `一键同步结束：${failedCount}/${steps.value.length} 步骤失败`,
      })
    } else {
      pushLog({ step: 'system', level: 'info', text: '一键同步全部完成' })
    }
  }

  function cancel() {
    if (!running.value) return
    cancelled.value = true
    const i = currentStepIndex.value
    if (i >= 0 && i < steps.value.length) {
      // best-effort 中断当前步骤的 SSE
      if (i === 1) moneyFlowCtrl.sse.reset()
      if (i === 2) thsIndexCtrl.sse.reset()
      // i === 0 (A 股) syncSse 句柄未暴露，依赖 cancelled watcher 让 awaitASharesDone 走 error 分支
      // i === 3/4/5 (个股/行业/概念 AMV) 与 i === 6 (0AMV) 均为普通 fetch，无 abort 句柄；等其返回
      setStepStatus(i, 'failed')
      const stepKey = steps.value[i].step
      steps.value[i].errors.push({ step: stepKey, level: 'warn', message: '用户取消' })
      pushLog({ step: stepKey, level: 'warn', text: '用户取消该步骤' })
    }
  }

  return {
    dateRange,
    running,
    cancelled,
    steps,
    currentStepIndex,
    elapsedMs,
    logEntries,
    summary,
    totalPercent,
    canStart,
    start,
    cancel,
  }
}
