import { defineStore } from 'pinia';
import { ref } from 'vue';
import { strategyConditionsApi } from '../api/modules/strategy/strategyConditions';
import type { StrategyCondition, RunProgress, LastRunStatus } from '../api/modules/strategy/strategyConditions';

export const useStrategyConditionsStore = defineStore('strategyConditions', () => {
  const conditions = ref<StrategyCondition[]>([]);
  const runStatuses = ref<Map<string, LastRunStatus>>(new Map());
  const runProgress = ref<Map<string, RunProgress>>(new Map());
  const loading = ref(false);
  const runningId = ref<string | null>(null);

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
    conditions.value = conditions.value.filter(c => c.id !== id);
    runStatuses.value.delete(id);
    runProgress.value.delete(id);
  }

  const lastPollError = ref<string | null>(null);

  async function startRun(id: string) {
    runningId.value = id;
    lastPollError.value = null;
    try {
      const { runId } = await strategyConditionsApi.startRun(id);

      const poll = setInterval(async () => {
        try {
          const progress = await strategyConditionsApi.getRunProgress(id);
          runProgress.value.set(id, progress);

          if (progress.status === 'completed' || progress.status === 'failed') {
            clearInterval(poll);
            runningId.value = null;
            await fetchLastRunStatus();
          }
        } catch (err: unknown) {
          // 不再静默吞错：记录错误供 UI 展示
          const msg = err instanceof Error ? err.message : '轮询进度失败';
          lastPollError.value = msg;
          // eslint-disable-next-line no-console
          console.warn(`[strategyConditions] poll progress failed for ${id}: ${msg}`);
          clearInterval(poll);
          runningId.value = null;
        }
      }, 500);

      // 30s timeout safety
      setTimeout(() => {
        clearInterval(poll);
        if (runningId.value === id) {
          runningId.value = null;
          if (!lastPollError.value) lastPollError.value = '运行轮询超时（30s）';
        }
      }, 30000);

      return { runId };
    } catch {
      runningId.value = null;
      throw new Error('启动运行失败');
    }
  }

  return {
    conditions,
    runStatuses,
    runProgress,
    loading,
    runningId,
    lastPollError,
    getConditionsByTargetType,
    fetchConditions,
    fetchLastRunStatus,
    createCondition,
    updateCondition,
    deleteCondition,
    startRun,
  };
});
