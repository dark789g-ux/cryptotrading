<!-- apps/web/src/components/symbols/common/StrategyConditionPicker.vue -->
<template>
  <div class="strategy-condition-picker">
    <n-space align="center">
      <n-select
        v-model:value="selectedIds"
        :options="conditionOptions"
        multiple
        placeholder="选择策略条件"
        style="width: 300px"
        :loading="store.loading"
      />
      <n-button
        type="primary"
        :loading="isRunning"
        :disabled="selectedIds.length === 0"
        @click="handleRun"
      >
        运行
      </n-button>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { NSelect, NButton, NSpace } from 'naive-ui';
import { useStrategyConditionsStore } from '../../../stores/strategyConditions';

interface Props {
  targetType: 'crypto' | 'a-share';
}

const props = defineProps<Props>();
const emit = defineEmits<{
  run: [results: Map<string, any>];
}>();

const store = useStrategyConditionsStore();
const selectedIds = ref<string[]>([]);
const isRunning = ref(false);

const conditionOptions = computed(() => {
  return store.getConditionsByTargetType(props.targetType).map(c => ({
    label: c.name,
    value: c.id,
  }));
});

async function handleRun() {
  isRunning.value = true;
  try {
    for (const id of selectedIds.value) {
      await store.runCondition(id);
    }
    emit('run', store.runResults);
    window.$message?.success('策略运行完成');
  } catch (error) {
    window.$message?.error('策略运行失败');
  } finally {
    isRunning.value = false;
  }
}

onMounted(() => {
  store.fetchConditions(props.targetType);
});
</script>

<style scoped>
.strategy-condition-picker {
  display: inline-flex;
}
</style>
