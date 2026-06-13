<!-- apps/web/src/components/strategy-conditions/ConditionRows.vue -->
<!-- 纯条件行列表编辑器：唯一真源，供 StrategyConditionBuilder 和 SignalTestForm 复用 -->
<template>
  <div class="condition-rows">
    <div v-for="(condition, index) in conditions" :key="index" class="condition-row">
      <n-space align="center" wrap>
        <n-select
          :value="condition.field"
          :options="fieldSelectOptions"
          placeholder="选择指标"
          class="field-select"
          @update:value="handleFieldChange(index, $event)"
        />
        <field-help-tip :field="condition.field" />
        <n-select
          :value="condition.operator"
          :options="getOperatorOptions(condition.field)"
          placeholder="选择操作符"
          style="width: 140px"
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
            :options="getCompareFieldOptions(condition.field)"
            placeholder="比较指标"
            class="field-select"
            @update:value="handleCompareFieldChange(index, $event)"
          />
        </template>
        <template v-else>
          <!-- 绑定 display 值；emit 前 fieldValueToStorage 写回 DB 原始量纲，父组件与 API 无感知 -->
          <n-input-number
            :value="fieldValueToDisplay(condition.field, targetType, condition.value)"
            :placeholder="getValuePlaceholder(condition.field)"
            :precision="getValuePrecision(condition.field)"
            style="width: 120px"
            @update:value="handleDisplayValueChange(index, $event)"
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
import FieldHelpTip from '../common/FieldHelpTip.vue';
import type { StrategyConditionItem } from '../../api/modules/strategy/strategyConditions';
import {
  A_SHARE_FIELDS,
  CRYPTO_FIELDS,
  BASE_OPERATOR_OPTIONS,
  formatFieldSelectLabel,
  fieldValueToDisplay,
  fieldValueToStorage,
  getFieldValueToStorageFactor,
  type FieldOption,
} from './conditionFieldMeta';

// ── Props & emits ─────────────────────────────────────────────────────────────

interface Props {
  conditions: StrategyConditionItem[];
  targetType: 'a-share' | 'crypto';
  /** 新增条件时的默认算子，默认 'gt' */
  defaultOperator?: string;
  /** 新增条件时的默认比较模式，默认 'value' */
  defaultCompareMode?: 'field' | 'value';
}

const props = withDefaults(defineProps<Props>(), {
  defaultOperator: 'gt',
  defaultCompareMode: 'value',
});

const emit = defineEmits<{
  'update:conditions': [conditions: StrategyConditionItem[]];
}>();

// ── Field compare groups (editor-only) ────────────────────────────────────────

/** 行业 AMV 字段：只能与行业 AMV 字段或常量比较（后端约束） */
const INDUSTRY_FIELD_VALUES = new Set(['ind_amv_dif', 'ind_amv_dea', 'ind_amv_macd']);

/** 大盘 0AMV 字段：只能与大盘 0AMV 字段或常量比较（后端约束） */
const MARKET_FIELD_VALUES = new Set(['oamv_dif', 'oamv_dea', 'oamv_macd', 'oamv_close', 'oamv_ma240']);

/** 上市元信息字段（天数量纲）：与价格/指标跨量纲比较无意义，仅常量比较 */
const LIST_META_FIELD_VALUES = new Set(['list_days']);

/** 字段所属比较组：行业 / 大盘 / 上市元信息 / 普通（个股），字段引用比较仅限同组互比 */
function fieldCompareGroup(v: string): 'industry' | 'market' | 'listmeta' | 'normal' {
  if (INDUSTRY_FIELD_VALUES.has(v)) return 'industry';
  if (MARKET_FIELD_VALUES.has(v)) return 'market';
  if (LIST_META_FIELD_VALUES.has(v)) return 'listmeta';
  return 'normal';
}

// ── Computed field options ────────────────────────────────────────────────────

const fieldOptions = computed<FieldOption[]>(() =>
  props.targetType === 'a-share' ? A_SHARE_FIELDS : CRYPTO_FIELDS,
);

const fieldSelectOptions = computed(() =>
  fieldOptions.value.map((f) => ({
    ...f,
    label: formatFieldSelectLabel(f),
  })),
);

function toFieldSelectOptions(fields: FieldOption[]) {
  return fields.map((f) => ({
    ...f,
    label: formatFieldSelectLabel(f),
  }));
}

// ── Logic helpers ─────────────────────────────────────────────────────────────

/**
 * 比较目标（字段引用模式）的可选字段：按左侧字段所属比较组过滤（行业/大盘/普通仅同组互比）。
 * crypto 无行业/大盘字段，组恒为 normal，过滤后等于全部 crypto 字段（行为不变）。
 */
function getCompareFieldOptions(fieldValue: string) {
  const all = props.targetType === 'a-share' ? A_SHARE_FIELDS : CRYPTO_FIELDS;
  const leftGroup = fieldCompareGroup(fieldValue);
  return toFieldSelectOptions(
    all.filter((f) => fieldCompareGroup(f.value as string) === leftGroup),
  );
}

function getOperatorOptions(fieldValue: string) {
  const fields = props.targetType === 'a-share' ? A_SHARE_FIELDS : CRYPTO_FIELDS;
  const fieldDef = fields.find((f) => f.value === fieldValue);
  const supportsCross = fieldDef?.supportsCross ?? false;
  return BASE_OPERATOR_OPTIONS.map((opt) => ({
    ...opt,
    disabled: !supportsCross && (opt.value === 'cross_above' || opt.value === 'cross_below'),
  }));
}

// ── Mutation helpers (immutable copy + emit) ──────────────────────────────────

function cloneConditions(): StrategyConditionItem[] {
  return props.conditions.map((c) => ({ ...c }));
}

function getValuePlaceholder(fieldValue: string): string {
  if (getFieldValueToStorageFactor(fieldValue, props.targetType) != null) {
    return '如 20.8';
  }
  return '数值';
}

function getValuePrecision(fieldValue: string): number | undefined {
  if (getFieldValueToStorageFactor(fieldValue, props.targetType) != null) {
    return 2;
  }
  return undefined;
}

function handleFieldChange(index: number, newField: string) {
  const copy = cloneConditions();
  const cond = copy[index];
  const oldField = cond.field;
  cond.field = newField;
  if (getFieldValueToStorageFactor(oldField, props.targetType)
    !== getFieldValueToStorageFactor(newField, props.targetType)) {
    cond.value = undefined;
  }
  // 切字段时，若当前算子为 cross 且新字段不支持，重置为 defaultOperator
  if (
    (cond.operator === 'cross_above' || cond.operator === 'cross_below') &&
    !getOperatorOptions(newField).find((o) => o.value === cond.operator && !o.disabled)
  ) {
    cond.operator = props.defaultOperator as StrategyConditionItem['operator'];
  }
  // 切换左侧字段后，若已选比较字段不在新的可选范围内（行业/非行业类别变了），重置
  if (
    cond.compareField &&
    !getCompareFieldOptions(newField).some((o) => o.value === cond.compareField)
  ) {
    cond.compareField = undefined;
  }
  emit('update:conditions', copy);
}

function handleOperatorChange(index: number, operator: string) {
  const copy = cloneConditions();
  copy[index].operator = operator as StrategyConditionItem['operator'];
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

function handleDisplayValueChange(index: number, display: number | null) {
  const copy = cloneConditions();
  const field = copy[index].field;
  copy[index].value = fieldValueToStorage(field, props.targetType, display);
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
      field: '',
      operator: props.defaultOperator as StrategyConditionItem['operator'],
      value: undefined,
      compareField: undefined,
      compareMode: props.defaultCompareMode,
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
.condition-rows {
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
  width: 240px;
}
</style>
