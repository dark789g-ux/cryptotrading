import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { strategyConditionsApi } from '../api/modules/strategyConditions';
import type { StrategyCondition, RunResult } from '../api/modules/strategyConditions';

export const useStrategyConditionsStore = defineStore('strategyConditions', () => {
  const conditions = ref<StrategyCondition[]>([]);
  const runResults = ref<Map<string, RunResult>>(new Map());
  const loading = ref(false);
  const runningId = ref<string | null>(null);

  const getConditionsByTargetType = computed(() => {
    return (targetType: 'crypto' | 'a-share') =>
      conditions.value.filter(c => c.targetType === targetType);
  });

  const getRunResultsByTargetType = computed(() => {
    return (targetType: 'crypto' | 'a-share') => {
      const result = new Map<string, RunResult>();
      runResults.value.forEach((value, key) => {
        const condition = conditions.value.find(c => c.id === key);
        if (condition && condition.targetType === targetType) {
          result.set(key, value);
        }
      });
      return result;
    };
  });

  async function fetchConditions(targetType?: string) {
    loading.value = true;
    try {
      const data = await strategyConditionsApi.findAll(targetType);
      conditions.value = data;
    } finally {
      loading.value = false;
    }
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
    if (index !== -1) {
      conditions.value[index] = data;
    }
    return data;
  }

  async function deleteCondition(id: string) {
    await strategyConditionsApi.remove(id);
    conditions.value = conditions.value.filter(c => c.id !== id);
    runResults.value.delete(id);
  }

  async function runCondition(id: string) {
    runningId.value = id;
    try {
      const data = await strategyConditionsApi.run(id);
      runResults.value.set(id, data);
      return data;
    } finally {
      runningId.value = null;
    }
  }

  function clearRunResults() {
    runResults.value.clear();
  }

  return {
    conditions,
    runResults,
    loading,
    runningId,
    getConditionsByTargetType,
    getRunResultsByTargetType,
    fetchConditions,
    createCondition,
    updateCondition,
    deleteCondition,
    runCondition,
    clearRunResults,
  };
});
