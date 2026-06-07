<!-- apps/web/src/components/strategy-conditions/StrategyConditionBuilder.vue -->
<template>
  <div class="strategy-condition-builder">
    <n-form :model="form" label-placement="left" label-width="80">
      <n-form-item label="条件组名称">
        <n-input v-model:value="form.name" placeholder="输入条件组名称" />
      </n-form-item>

      <n-form-item label="目标类型">
        <n-radio-group v-model:value="form.targetType" :disabled="!!editId">
          <n-radio-button value="a-share">A 股</n-radio-button>
          <n-radio-button value="crypto">加密货币</n-radio-button>
        </n-radio-group>
      </n-form-item>

      <n-divider>条件列表</n-divider>

      <condition-rows
        v-model:conditions="form.conditions"
        :target-type="form.targetType"
        default-operator="lt"
        default-compare-mode="field"
      />
    </n-form>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { NForm, NFormItem, NInput, NRadioGroup, NRadioButton, NDivider, useMessage } from 'naive-ui';
import type { StrategyConditionItem } from '../../api/modules/strategy/strategyConditions';
import ConditionRows from './ConditionRows.vue';

const message = useMessage()

interface Props {
  editId?: string;
  initialData?: {
    name: string;
    targetType: 'crypto' | 'a-share';
    conditions: StrategyConditionItem[];
  };
}

const props = defineProps<Props>();
const emit = defineEmits<{
  save: [data: { name: string; targetType: string; conditions: StrategyConditionItem[] }];
}>();

const form = ref({
  name: '',
  targetType: 'a-share' as 'crypto' | 'a-share',
  conditions: [] as StrategyConditionItem[],
});

watch(() => props.initialData, (data) => {
  if (data) {
    form.value = {
      name: data.name,
      targetType: data.targetType,
      conditions: data.conditions.map(c => ({
        ...c,
        compareMode: c.compareMode ?? (c.compareField ? 'field' : 'value'),
      })),
    };
  }
}, { immediate: true });

function handleSave() {
  if (!form.value.name) {
    message.warning('请输入条件组名称');
    return;
  }
  if (form.value.conditions.length === 0) {
    message.warning('请添加至少一个条件');
    return;
  }
  emit('save', { ...form.value });
}

defineExpose({
  submit: handleSave,
});
</script>

<style scoped>
.strategy-condition-builder {
  padding: 16px;
}
</style>
