<template>
  <div class="regime-bucket-condition-rows">
    <div
      v-for="(condition, index) in conditions"
      :key="index"
      class="condition-row"
    >
      <n-space align="center" wrap>
        <n-select
          :value="condition.type"
          :options="TYPE_OPTIONS"
          placeholder="类型"
          style="width: 100px"
          @update:value="handleTypeChange(index, $event)"
        />
        <regime-target-search
          :type="condition.type"
          :value="condition.target"
          @update:value="handleTargetChange(index, $event)"
        />
        <n-select
          :value="condition.field"
          :options="fieldSelectOptions(condition.type)"
          placeholder="字段"
          class="field-select"
          @update:value="handleFieldChange(index, $event)"
        />
        <n-select
          :value="condition.operator"
          :options="operatorOptions(condition)"
          placeholder="操作符"
          class="operator-select"
          @update:value="handleOperatorChange(index, $event)"
        />
        <n-radio-group
          :value="condition.compareMode ?? 'value'"
          size="small"
          @update:value="handleCompareModeChange(index, $event)"
        >
          <n-radio-button value="field">指标</n-radio-button>
          <n-radio-button value="value">数值</n-radio-button>
        </n-radio-group>
        <template v-if="condition.compareMode === 'field'">
          <n-select
            :value="condition.compareField"
            :options="fieldSelectOptions(condition.type)"
            placeholder="比较字段"
            class="field-select"
            @update:value="handleCompareFieldChange(index, $event)"
          />
        </template>
        <template v-else>
          <n-input-number
            :value="displayValue(condition)"
            :placeholder="valuePlaceholder(condition)"
            class="value-input"
            @update:value="handleValueChange(index, $event)"
          />
        </template>
        <n-button type="error" text @click="removeCondition(index)">
          <template #icon><n-icon><trash-icon /></n-icon></template>
        </n-button>
      </n-space>
    </div>

    <n-button dashed block class="add-btn" @click="addCondition">
      <template #icon><n-icon><add-icon /></n-icon></template>
      添加条件
    </n-button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  NSelect,
  NInputNumber,
  NButton,
  NIcon,
  NSpace,
  NRadioGroup,
  NRadioButton,
} from 'naive-ui';
import { Add as AddIcon, Trash as TrashIcon } from '@vicons/ionicons5';
import RegimeTargetSearch from './RegimeTargetSearch.vue';
import {
  getRegimeBucketFields,
  BASE_OPERATOR_OPTIONS,
  formatFieldSelectLabel,
  type FieldOption,
} from '../strategy-conditions/conditionFieldMeta';

export type RegimeBucketConditionType = 'index' | 'stock';

export interface RegimeBucketCondition {
  type: RegimeBucketConditionType;
  target: string;
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'cross_above' | 'cross_below';
  compareMode?: 'field' | 'value';
  value?: number;
  compareField?: string;
}

interface Props {
  conditions: RegimeBucketCondition[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:conditions': [conditions: RegimeBucketCondition[]];
}>();

const TYPE_OPTIONS = computed(() => [
  { label: '指数', value: 'index' },
  { label: '个股', value: 'stock' },
]);

const DEFAULT_OPERATOR: RegimeBucketCondition['operator'] = 'gt';

function cloneConditions(): RegimeBucketCondition[] {
  return props.conditions.map((c) => ({ ...c }));
}

function fieldOptions(type: RegimeBucketConditionType): FieldOption[] {
  const fields = getRegimeBucketFields(type);
  if (type === 'stock') {
    return fields.filter(
      (f) =>
        !String(f.value).startsWith('idx_') &&
        !String(f.value).startsWith('oamv_') &&
        !String(f.value).startsWith('ind_amv_'),
    );
  }
  return fields;
}

function fieldSelectOptions(type: RegimeBucketConditionType) {
  return fieldOptions(type).map((f) => ({
    ...f,
    label: formatFieldSelectLabel(f),
  }));
}

function getFieldDef(type: RegimeBucketConditionType, field: string): FieldOption | undefined {
  return fieldOptions(type).find((f) => f.value === field);
}

function getFieldFactor(type: RegimeBucketConditionType, field: string): number | undefined {
  return getFieldDef(type, field)?.valueToStorageFactor;
}

function displayValue(condition: RegimeBucketCondition): number | undefined {
  const { type, field, value } = condition;
  if (field == null || value == null) return undefined;
  const factor = getFieldFactor(type, field);
  if (factor == null) return value;
  return value / factor;
}

function storageValue(
  type: RegimeBucketConditionType,
  field: string,
  display: number | null,
): number | undefined {
  if (display == null) return undefined;
  const factor = getFieldFactor(type, field);
  if (factor == null) return display;
  return display * factor;
}

function valuePlaceholder(condition: RegimeBucketCondition): string {
  const factor = getFieldFactor(condition.type, condition.field ?? '');
  return factor != null ? '如 20.8' : '数值';
}

function operatorOptions(condition: RegimeBucketCondition) {
  const fieldDef = condition.field ? getFieldDef(condition.type, condition.field) : undefined;
  const supportsCross = fieldDef?.supportsCross ?? false;
  return BASE_OPERATOR_OPTIONS.map((opt) => ({
    ...opt,
    disabled: !supportsCross && (opt.value === 'cross_above' || opt.value === 'cross_below'),
  }));
}

function handleTypeChange(index: number, type: RegimeBucketConditionType) {
  const copy = cloneConditions();
  copy[index] = {
    ...copy[index],
    type,
    target: '',
    field: '',
    operator: DEFAULT_OPERATOR,
    compareField: undefined,
    value: undefined,
  };
  emit('update:conditions', copy);
}

function handleTargetChange(index: number, target: string | null) {
  const copy = cloneConditions();
  copy[index].target = target ?? '';
  emit('update:conditions', copy);
}

function handleFieldChange(index: number, field: string) {
  const copy = cloneConditions();
  const cond = copy[index];
  const prevFactor = getFieldFactor(cond.type, cond.field ?? '');
  const nextFactor = getFieldFactor(cond.type, field);
  cond.field = field;
  if (prevFactor !== nextFactor) {
    cond.value = undefined;
  }
  const fieldDef = getFieldDef(cond.type, field);
  const supportsCross = fieldDef?.supportsCross ?? false;
  if (!supportsCross && (cond.operator === 'cross_above' || cond.operator === 'cross_below')) {
    cond.operator = DEFAULT_OPERATOR;
  }
  emit('update:conditions', copy);
}

function handleOperatorChange(index: number, operator: string) {
  const copy = cloneConditions();
  copy[index].operator = operator as RegimeBucketCondition['operator'];
  emit('update:conditions', copy);
}

function handleCompareModeChange(index: number, mode: 'field' | 'value') {
  const copy = cloneConditions();
  copy[index].compareMode = mode;
  if (mode === 'field') {
    copy[index].value = undefined;
  } else {
    copy[index].compareField = undefined;
  }
  emit('update:conditions', copy);
}

function handleValueChange(index: number, display: number | null) {
  const copy = cloneConditions();
  const cond = copy[index];
  cond.value = storageValue(cond.type, cond.field ?? '', display);
  emit('update:conditions', copy);
}

function handleCompareFieldChange(index: number, compareField: string) {
  const copy = cloneConditions();
  copy[index].compareField = compareField;
  emit('update:conditions', copy);
}

function addCondition() {
  emit('update:conditions', [
    ...props.conditions,
    {
      type: 'index',
      target: '',
      field: '',
      operator: DEFAULT_OPERATOR,
      value: undefined,
      compareField: undefined,
      compareMode: 'value',
    },
  ]);
}

function removeCondition(index: number) {
  const copy = cloneConditions();
  copy.splice(index, 1);
  emit('update:conditions', copy);
}
</script>

<style scoped>
.regime-bucket-condition-rows {
  padding: 0;
}

.condition-row {
  margin-bottom: 12px;
  padding: 12px;
  background: var(--n-color);
  border-radius: 4px;
}

.add-btn {
  margin-top: 8px;
}

.field-select {
  width: 220px;
}

.operator-select {
  width: 130px;
}

.value-input {
  width: 140px;
}
</style>
