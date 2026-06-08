<!-- apps/web/src/components/strategy-conditions/ConditionRows.vue -->
<!-- 纯条件行列表编辑器：唯一真源，供 StrategyConditionBuilder 和 SignalTestForm 复用 -->
<template>
  <div class="condition-rows">
    <div v-for="(condition, index) in conditions" :key="index" class="condition-row">
      <n-space align="center" wrap>
        <n-select
          :value="condition.field"
          :options="fieldOptions"
          placeholder="选择指标"
          style="width: 180px"
          @update:value="handleFieldChange(index, $event)"
        />
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
            style="width: 180px"
            @update:value="handleCompareFieldChange(index, $event)"
          />
        </template>
        <template v-else>
          <n-input-number
            :value="condition.value"
            placeholder="数值"
            style="width: 120px"
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
import type { SelectOption } from 'naive-ui';
import { Add as AddIcon, Trash as TrashIcon } from '@vicons/ionicons5';
import type { StrategyConditionItem } from '../../api/modules/strategy/strategyConditions';

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

// ── Field definitions (唯一真源) ──────────────────────────────────────────────

interface FieldOption extends SelectOption {
  /** 是否支持上穿/下穿（仅单表指标字段可用） */
  supportsCross?: boolean;
}

/** 行业 AMV 字段：只能与行业 AMV 字段或常量比较（后端约束） */
const INDUSTRY_FIELD_VALUES = new Set(['ind_amv_dif', 'ind_amv_dea', 'ind_amv_macd']);

const A_SHARE_FIELDS: FieldOption[] = [
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
  // 滚动区间位置 / 量比（跨表，不支持上穿/下穿）
  { label: '120日区间位置', value: 'pos_120', supportsCross: false },
  { label: '60日区间位置', value: 'pos_60', supportsCross: false },
  { label: '收盘/MA60', value: 'close_ma60_ratio', supportsCross: false },
  { label: '量比(60日均量)', value: 'vol_ratio_60', supportsCross: false },
  { label: '量比(120日均量)', value: 'vol_ratio_120', supportsCross: false },
];

const CRYPTO_FIELDS: FieldOption[] = [
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

// ── Computed field options ────────────────────────────────────────────────────

const fieldOptions = computed<FieldOption[]>(() =>
  props.targetType === 'a-share' ? A_SHARE_FIELDS : CRYPTO_FIELDS,
);

// ── Logic helpers ─────────────────────────────────────────────────────────────

/**
 * 比较目标（字段引用模式）的可选字段：按左侧字段是否为行业 AMV 字段过滤。
 * 左侧是行业字段 → 只返回行业字段；左侧非行业字段 → 只返回非行业字段。
 * crypto 无行业字段，leftIsIndustry 恒 false，过滤后等于全部 crypto 字段（行为不变）。
 */
function getCompareFieldOptions(fieldValue: string): FieldOption[] {
  const all = props.targetType === 'a-share' ? A_SHARE_FIELDS : CRYPTO_FIELDS;
  const leftIsIndustry = INDUSTRY_FIELD_VALUES.has(fieldValue);
  return all.filter((f) => INDUSTRY_FIELD_VALUES.has(f.value as string) === leftIsIndustry);
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

function handleFieldChange(index: number, newField: string) {
  const copy = cloneConditions();
  const cond = copy[index];
  cond.field = newField;
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

function handleValueChange(index: number, value: number | null) {
  const copy = cloneConditions();
  copy[index].value = value ?? undefined;
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
</style>
