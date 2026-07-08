import { defineStore } from 'pinia';
import { ref } from 'vue';
import { strategyConditionsApi } from '../api/modules/strategy/strategyConditions';
import type { StrategyCondition, RunProgress, LastRunStatus } from '../api/modules/strategy/strategyConditions';

/** 连续轮询失败多少次才放弃（TODO 问题 3：零容错 → 连续 N 次才停） */
const MAX_POLL_FAILURES = 5;
/** 两段式自适应间隔（TODO 问题 4）：前 N 次快，之后慢，兼顾「启动即反馈」与「稳态减负」。
 *  后端进度粒度 = 每 100 只 +1（全市场约 50 次更新），拉长间隔不丢帧。 */
const FAST_POLL_MS = 400;       // 前 N 次快间隔：启动后立刻看到动
const SLOW_POLL_MS = 1500;      // 之后慢间隔：稳态减负，请求量降 3 倍
const FAST_POLL_COUNT = 5;      // 快间隔次数阈值

export const useStrategyConditionsStore = defineStore('strategyConditions', () => {
  const conditions = ref<StrategyCondition[]>([]);
  const runStatuses = ref<Map<string, LastRunStatus>>(new Map());
  const runProgress = ref<Map<string, RunProgress>>(new Map());
  const loading = ref(false);
  /**
   * 当前正在轮询进度的 conditionId 集合（TODO 问题 5 前端部分：支持并发）。
   * 后端不同 conditionId 可并发（service 无全局锁），故由单值升级为 Set。
   * 同一 conditionId 由后端 409 防重复。
   */
  const runningIds = ref<Set<string>>(new Set());
  /** 每个 id 的轮询 timer 句柄：保证 pollRunProgress 幂等、终态可清理、避免泄漏。 */
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 每个条件组最近一次运行/轮询的错误信息（per-condition，避免并发失败互相覆盖）。
   *  数据源双轨：轮询期写入 + 刷新后 LastRunStatus.errorMessage 带回（见 view 取值）。 */
  const lastPollErrors = ref<Map<string, string>>(new Map());
  const getLastError = (id: string) => lastPollErrors.value.get(id);

  const isRunning = (id: string) => runningIds.value.has(id);

  const getConditionsByTargetType = (targetType: 'crypto' | 'a-share') =>
    conditions.value.filter(c => c.targetType === targetType);

  async function fetchConditions(targetType?: string) {
    loading.value = true;
    try {
      const data = await strategyConditionsApi.findAll(targetType);
      conditions.value = data;
    } finally {
      loading.value = false;
    }
  }

  async function fetchLastRunStatus() {
    const data = await strategyConditionsApi.getLastRunStatus();
    runStatuses.value = new Map(data.map(s => [s.conditionId, s]));
  }

  async function createCondition(dto: {
    name: string;
    targetType: 'crypto' | 'a-share';
    conditions: any[];
  }) {
    const data = await strategyConditionsApi.create(dto);
    conditions.value.unshift(data);
    return data;
  }

  async function updateCondition(id: string, dto: { name?: string; conditions?: any[] }) {
    const data = await strategyConditionsApi.update(id, dto);
    const index = conditions.value.findIndex(c => c.id === id);
    if (index !== -1) conditions.value[index] = data;
    return data;
  }

  async function deleteCondition(id: string) {
    await strategyConditionsApi.remove(id);
    stopPoll(id); // 删除条件组时停掉可能仍在跑的轮询
    conditions.value = conditions.value.filter(c => c.id !== id);
    runStatuses.value.delete(id);
    runProgress.value.delete(id);
    lastPollErrors.value.delete(id);
  }

  /** 停止某 id 的轮询并清理状态：终态 / 放弃 / 删除条件组共用。 */
  function stopPoll(id: string) {
    const timer = pollTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      pollTimers.delete(id);
    }
    runningIds.value.delete(id);
  }

  /**
   * 对给定 id 启动进度轮询（幂等：已有轮询在跑则直接返回）。
   *
   * - 终态（completed/failed）：停轮询 + 同步状态 + 清 runProgress（TODO 问题 9）。
   * - 连续 MAX_POLL_FAILURES 次失败才停（TODO 问题 3），中间容错继续；
   *   放弃后不判任务失败，调 fetchLastRunStatus 同步后端真实状态（TODO 问题 1 方案 B）。
   *
   * 供 startRun 与 resumeRunningPolls 复用（TODO 问题 2：刷新后恢复轮询）。
   */
  function pollRunProgress(id: string) {
    if (pollTimers.has(id)) return; // 幂等：避免重复起轮询
    runningIds.value.add(id);
    let consecutiveFailures = 0;
    let pollCount = 0;

    // 递归 setTimeout：每次回调完成后才调度下一次，天然串行化请求，
    // 消除 setInterval 在慢网络下「上一次未完成下一次已触发」的并发堆积隐患。
    const scheduleNext = () => {
      const delay = pollCount < FAST_POLL_COUNT ? FAST_POLL_MS : SLOW_POLL_MS;
      const handle = setTimeout(tick, delay);
      pollTimers.set(id, handle);
    };

    const tick = async () => {
      try {
        const progress = await strategyConditionsApi.getRunProgress(id);
        runProgress.value.set(id, progress);
        consecutiveFailures = 0;
        pollCount += 1;

        if (progress.status === 'completed' || progress.status === 'failed') {
          stopPoll(id);
          runProgress.value.delete(id); // 问题 9：终态后清理进度 Map
          if (progress.status === 'failed') {
            lastPollErrors.value.set(id, progress.errorMessage ?? '运行失败（后端未返回错误信息）');
          }
          await fetchLastRunStatus();
          return; // 终态：不再调度
        }
        // queued / running：继续轮询
        scheduleNext();
      } catch (err: unknown) {
        consecutiveFailures += 1;
        const msg = err instanceof Error ? err.message : '轮询进度失败';
        // eslint-disable-next-line no-console
        console.warn(
          `[strategyConditions] poll progress failed for ${id} ` +
            `(${consecutiveFailures}/${MAX_POLL_FAILURES}): ${msg}`,
        );
        if (consecutiveFailures >= MAX_POLL_FAILURES) {
          stopPoll(id);
          lastPollErrors.value.set(
            id,
            `进度轮询连续失败 ${MAX_POLL_FAILURES} 次，已停止；任务可能仍在后端运行，刷新页面可恢复`,
          );
          await fetchLastRunStatus();
          return; // 放弃：不再调度
        }
        scheduleNext(); // 未达阈值：容错继续
      }
    };

    scheduleNext(); // 启动第一次
  }

  async function startRun(id: string) {
    lastPollErrors.value.delete(id);
    runningIds.value.add(id);
    try {
      const { runId, status } = await strategyConditionsApi.startRun(id);
      // queued 也启轮询：轮询会在 status='queued' 时继续，直到变 running/completed/failed
      pollRunProgress(id);
      return { runId, status };
    } catch (err: unknown) {
      runningIds.value.delete(id);
      const msg = err instanceof Error ? err.message : '启动运行失败';
      throw new Error(`启动运行失败：${msg}`);
    }
  }

  /**
   * 刷新 / 切回页面后恢复后端仍在运行的任务的轮询（TODO 问题 2）。
   * 必须在 fetchLastRunStatus() 之后调用——依赖 runStatuses 已填充。
   * 只轮询进度，不重新 POST run（避免重复触发，后端 409 也会挡）。
   */
  function resumeRunningPolls() {
    for (const [conditionId, status] of runStatuses.value) {
      if (status.freshness === 'running') {
        pollRunProgress(conditionId);
      }
    }
  }

  return {
    conditions,
    runStatuses,
    runProgress,
    loading,
    runningIds,
    lastPollErrors,
    getLastError,
    isRunning,
    getConditionsByTargetType,
    fetchConditions,
    fetchLastRunStatus,
    createCondition,
    updateCondition,
    deleteCondition,
    startRun,
    resumeRunningPolls,
  };
});
