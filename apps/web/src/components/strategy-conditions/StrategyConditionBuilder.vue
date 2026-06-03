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

      <div v-for="(condition, index) in form.conditions" :key="index" class="condition-row">
        <n-space align="center">
          <n-select
            v-model:value="condition.field"
            :options="fieldOptions"
            placeholder="选择指标"
            style="width: 180px"
            @update:value="handleFieldChange(condition, $event)"
          />
          <n-select
            v-model:value="condition.operator"
            :options="getOperatorOptions(condition.field)"
            placeholder="选择操作符"
            style="width: 140px"
          />
          <n-radio-group
            :value="condition.compareMode"
            size="small"
            @update:value="handleCompareModeChange(condition, $event)"
          >
            <n-radio-button value="field">指标</n-radio-button>
            <n-radio-button value="value">数值</n-radio-button>
          </n-radio-group>
          <template v-if="condition.compareMode === 'field'">
            <n-select
              v-model:value="condition.compareField"
              :options="fieldOptions"
              placeholder="比较指标"
              style="width: 180px"
            />
          </template>
          <template v-else>
            <n-input-number
              v-model:value="condition.value"
              placeholder="数值"
              style="width: 120px"
            />
          </template>
          <n-button type="error" text @click="removeCondition(index)">
            <template #icon><n-icon><trash-icon /></n-icon></template>
          </n-button>
        </n-space>
      </div>

      <n-button dashed block @click="addCondition" class="add-btn">
        <template #icon><n-icon><add-icon /></n-icon></template>
        添加条件
      </n-button>
    </n-form>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { NForm, NFormItem, NInput, NSelect, NInputNumber, NButton, NIcon, NSpace, NDivider, NRadioGroup, NRadioButton, useMessage } from 'naive-ui';
import type { SelectOption } from 'naive-ui';
import { Add as AddIcon, Trash as TrashIcon } from '@vicons/ionicons5';
import type { StrategyConditionItem } from '../../api/modules/strategy/strategyConditions';

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

interface FieldOption extends SelectOption {
  /** 是否支持上穿/下穿（仅单表指标字段可用） */
  supportsCross?: boolean;
}

const aShareFields: FieldOption[] = [
  { label: 'KDJ_J', value: 'kdj_j', supportsCross: true },
  { label: 'KDJ_K', value: 'kdj_k', supportsCross: true },
  { label: 'KDJ_D', value: 'kdj_d', supportsCross: true },
  { label: 'MACD_DIF', value: 'macd_dif', supportsCross: true },
  { label: 'MACD_DEA', value: 'macd_dea', supportsCross: true },
  { label: 'MACD_HIST', value: 'macd_hist', supportsCross: true },
  { label: 'BBI', value: 'bbi', supportsCross: true },
  { label: 'MA5', value: 'ma5', supportsCross: true },
  { label: 'MA30', value: 'ma30', supportsCross: true },
  { label: 'MA60', value: 'ma60', supportsCross: true },
  { label: 'MA120', value: 'ma120', supportsCross: true },
  { label: 'MA240', value: 'ma240', supportsCross: true },
  { label: 'ATR14', value: 'atr14', supportsCross: true },
  { label: '盈亏比', value: 'profit_loss_ratio', supportsCross: true },
  { label: '砖形图', value: 'brick', supportsCross: true },
  { label: '砖形图变动', value: 'brick_delta', supportsCross: true },
  { label: '砖形图信号', value: 'brick_xg' },
  // 行情 / 估值字段（跨表，不支持上穿/下穿）
  { label: '换手率', value: 'turnover_rate' },
  { label: '量比', value: 'volume_ratio' },
  { label: 'PE', value: 'pe' },
  { label: 'PE_TTM', value: 'pe_ttm' },
  { label: 'PB', value: 'pb' },
  { label: '总市值', value: 'total_mv' },
  { label: '流通市值', value: 'circ_mv' },
  { label: '收盘价', value: 'close' },
  { label: '开盘价', value: 'open' },
  { label: '最高价', value: 'high' },
  { label: '最低价', value: 'low' },
  { label: '成交量', value: 'volume' },
  { label: '成交额', value: 'amount' },
  { label: '涨跌幅', value: 'pct_chg' },
  // 个股 AMV-MACD（stock_amv_daily）
  { label: 'AMV-MACD-DIF', value: 'amv_dif', supportsCross: false },
  { label: 'AMV-MACD-DEA', value: 'amv_dea', supportsCross: false },
  { label: 'AMV-MACD-MACD', value: 'amv_macd', supportsCross: false },
  // 个股所在行业 AMV-MACD（industry_amv_daily，任一行业达标即命中）
  { label: '行业AMV-MACD-DIF', value: 'ind_amv_dif', supportsCross: false },
  { label: '行业AMV-MACD-DEA', value: 'ind_amv_dea', supportsCross: false },
  { label: '行业AMV-MACD-MACD', value: 'ind_amv_macd', supportsCross: false },
];

const cryptoFields: FieldOption[] = [
  { label: 'KDJ_J', value: 'kdj_j', supportsCross: true },
  { label: 'KDJ_K', value: 'kdj_k', supportsCross: true },
  { label: 'KDJ_D', value: 'kdj_d', supportsCross: true },
  { label: 'MACD_DIF', value: 'macd_dif', supportsCross: true },
  { label: 'MACD_DEA', value: 'macd_dea', supportsCross: true },
  { label: 'MACD_HIST', value: 'macd_hist', supportsCross: true },
  { label: 'BBI', value: 'bbi', supportsCross: true },
  { label: 'MA5', value: 'ma5', supportsCross: true },
  { label: 'MA30', value: 'ma30', supportsCross: true },
  { label: 'MA60', value: 'ma60', supportsCross: true },
  { label: 'MA120', value: 'ma120', supportsCross: true },
  { label: 'MA240', value: 'ma240', supportsCross: true },
  { label: 'ATR14', value: 'atr14', supportsCross: true },
  { label: '盈亏比', value: 'profit_loss_ratio', supportsCross: true },
  { label: '收盘价', value: 'close', supportsCross: true },
  { label: '开盘价', value: 'open', supportsCross: true },
  { label: '最高价', value: 'high', supportsCross: true },
  { label: '最低价', value: 'low', supportsCross: true },
  { label: '成交量', value: 'volume', supportsCross: true },
  { label: '成交额', value: 'amount', supportsCross: true },
];

const fieldOptions = computed(() => {
  return form.value.targetType === 'a-share' ? aShareFields : cryptoFields;
});

const BASE_OPERATOR_OPTIONS = [
  { label: '大于', value: 'gt' },
  { label: '大于等于', value: 'gte' },
  { label: '小于', value: 'lt' },
  { label: '小于等于', value: 'lte' },
  { label: '等于', value: 'eq' },
  { label: '不等于', value: 'neq' },
  { label: '上穿', value: 'cross_above' },
  { label: '下穿', value: 'cross_below' },
];

function getOperatorOptions(fieldValue: string) {
  const fields = form.value.targetType === 'a-share' ? aShareFields : cryptoFields;
  const fieldDef = fields.find(f => f.value === fieldValue);
  const supportsCross = fieldDef?.supportsCross ?? false;
  return BASE_OPERATOR_OPTIONS.map(opt => ({
    ...opt,
    disabled: !supportsCross && (opt.value === 'cross_above' || opt.value === 'cross_below'),
  }));
}

function handleFieldChange(condition: StrategyConditionItem, newField: string) {
  condition.field = newField;
  if (
    (condition.operator === 'cross_above' || condition.operator === 'cross_below') &&
    !getOperatorOptions(newField).find(o => o.value === condition.operator && !o.disabled)
  ) {
    condition.operator = 'gt';
  }
}

function addCondition() {
  form.value.conditions.push({
    field: '',
    operator: 'lt',
    value: undefined,
    compareField: undefined,
    compareMode: 'field',
  });
}

function handleCompareModeChange(condition: StrategyConditionItem, mode: 'field' | 'value') {
  condition.compareMode = mode;
  if (mode === 'field') {
    condition.value = undefined;
  } else {
    condition.compareField = undefined;
  }
}

function removeCondition(index: number) {
  form.value.conditions.splice(index, 1);
}

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

.condition-row {
  margin-bottom: 12px;
  padding: 12px;
  background: var(--n-color);
  border-radius: 4px;
}

.add-btn {
  margin-top: 12px;
}
</style>
