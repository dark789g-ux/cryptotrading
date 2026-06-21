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
        <!-- 行内 KDJ 参数 N/M1/M2：仅 a-share + KDJ 字段渲染（crypto v1 走固定 9/3/3，不显示以免误导） -->
        <template v-if="showKdjParams(condition.field)">
          <span class="kdj-params-label">参数</span>
          <n-input-number
            :value="kdjParamView(condition).n"
            placeholder="N"
            :min="1"
            :max="99"
            :precision="0"
            class="kdj-param-input"
            @update:value="handleKdjParamChange(index, 'n', $event)"
          />
          <n-input-number
            :value="kdjParamView(condition).m1"
            placeholder="M1"
            :min="1"
            :max="99"
            :precision="0"
            class="kdj-param-input"
            @update:value="handleKdjParamChange(index, 'm1', $event)"
          />
          <n-input-number
            :value="kdjParamView(condition).m2"
            placeholder="M2"
            :min="1"
            :max="99"
            :precision="0"
            class="kdj-param-input"
            @update:value="handleKdjParamChange(index, 'm2', $event)"
          />
        </template>
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
            :options="getCompareFieldOptions(condition)"
            placeholder="比较指标"
            class="field-select"
            @update:value="handleCompareFieldChange(index, $event)"
          />
          <!-- 自定义 KDJ + 右侧也是 KDJ：右侧不另出参数框，沿用左侧同一组参数 -->
          <span
            v-if="isCustomKdj(condition) && isKdjField(condition.compareField ?? '')"
            class="kdj-same-params-hint"
          >
            （同参数）
          </span>
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
  DEFAULT_KDJ_PARAMS,
  formatFieldSelectLabel,
  fieldValueToDisplay,
  fieldValueToStorage,
  getFieldValueToStorageFactor,
  isKdjField,
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
  /**
   * 是否启用 KDJ 行内自定义参数（N/M1/M2）。默认 false。
   * 仅当消费方后端会按用户填的参数实时重算 KDJ 时才置 true（目前只有 StrategyConditionBuilder）。
   * 其余消费方后端不重算，启用会让自定义参数被静默按 9/3/3 算 —— 故默认隐藏参数框、不收窄 compareField。
   */
  enableKdjParams?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  defaultOperator: 'gt',
  defaultCompareMode: 'value',
  enableKdjParams: false,
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

// ── KDJ inline params (a-share only) ──────────────────────────────────────────

/** 行内参数框是否渲染：仅启用参数的消费方 + a-share + KDJ 字段（crypto 不显示，v1 走固定 9/3/3） */
function showKdjParams(fieldValue: string): boolean {
  return props.enableKdjParams && props.targetType === 'a-share' && isKdjField(fieldValue);
}

/** 该行是否为「自定义 KDJ」：启用参数 + a-share + KDJ 字段 + 已写入非默认 kdjParams */
function isCustomKdj(condition: StrategyConditionItem): boolean {
  return (
    props.enableKdjParams &&
    props.targetType === 'a-share' &&
    isKdjField(condition.field) &&
    condition.kdjParams != null
  );
}

/** 输入框视图模型：缺省回落 9/3/3，缺字段不污染 item */
function kdjParamView(condition: StrategyConditionItem): { n: number; m1: number; m2: number } {
  return condition.kdjParams ?? { ...DEFAULT_KDJ_PARAMS };
}

function isDefaultKdjParams(p: { n: number; m1: number; m2: number }): boolean {
  return p.n === DEFAULT_KDJ_PARAMS.n && p.m1 === DEFAULT_KDJ_PARAMS.m1 && p.m2 === DEFAULT_KDJ_PARAMS.m2;
}

// ── Logic helpers ─────────────────────────────────────────────────────────────

/**
 * 比较目标（字段引用模式）的可选字段：按左侧字段所属比较组过滤（行业/大盘/普通仅同组互比）。
 * 自定义 KDJ 行（非默认参数）额外收紧：只允许 KDJ 字段（跨参数比较语义只在同为 KDJ 时成立）。
 * crypto 无行业/大盘字段，组恒为 normal，过滤后等于全部 crypto 字段（行为不变）。
 */
function getCompareFieldOptions(condition: StrategyConditionItem) {
  const all = props.targetType === 'a-share' ? A_SHARE_FIELDS : CRYPTO_FIELDS;
  const leftGroup = fieldCompareGroup(condition.field);
  const sameGroup = all.filter((f) => fieldCompareGroup(f.value as string) === leftGroup);
  if (isCustomKdj(condition)) {
    return toFieldSelectOptions(sameGroup.filter((f) => isKdjField(f.value as string)));
  }
  return toFieldSelectOptions(sameGroup);
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
  // 切走 KDJ（或 crypto 不支持行内参数）时清除自定义 KDJ 参数，避免脏字段残留
  if (!showKdjParams(newField)) {
    delete cond.kdjParams;
  }
  // 切字段时，若当前算子为 cross 且新字段不支持，重置为 defaultOperator
  if (
    (cond.operator === 'cross_above' || cond.operator === 'cross_below') &&
    !getOperatorOptions(newField).find((o) => o.value === cond.operator && !o.disabled)
  ) {
    cond.operator = props.defaultOperator as StrategyConditionItem['operator'];
  }
  // 切换左侧字段后，若已选比较字段不在新的可选范围内（行业/非行业类别变了，或离开自定义 KDJ 约束），重置
  if (
    cond.compareField &&
    !getCompareFieldOptions(cond).some((o) => o.value === cond.compareField)
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

/**
 * KDJ 行内参数改动：以缺省 9/3/3 视图模型做 write-through。
 * 等于默认 → 删除 kdjParams（item 不残留默认值）；否则写入。
 * 仅 a-share + KDJ 字段路径会调用（模板已 gate）。
 */
function handleKdjParamChange(index: number, key: 'n' | 'm1' | 'm2', raw: number | null) {
  const copy = cloneConditions();
  const cond = copy[index];
  const next = { ...kdjParamView(cond) };
  // n-input-number 清空回 null 时回落默认值，避免出现 NaN/空
  next[key] = raw == null ? DEFAULT_KDJ_PARAMS[key] : raw;
  if (isDefaultKdjParams(next)) {
    delete cond.kdjParams;
  } else {
    cond.kdjParams = next;
  }
  // 参数切换到自定义后，若 compareMode=field 且已选的 compareField 不再合法（非 KDJ），重置
  if (
    cond.compareMode === 'field' &&
    cond.compareField &&
    !getCompareFieldOptions(cond).some((o) => o.value === cond.compareField)
  ) {
    cond.compareField = undefined;
  }
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

.kdj-params-label {
  font-size: 12px;
  color: var(--n-text-color-3, #999);
}

.kdj-param-input {
  width: 72px;
}

.kdj-same-params-hint {
  font-size: 12px;
  color: var(--n-text-color-3, #999);
}
</style>
