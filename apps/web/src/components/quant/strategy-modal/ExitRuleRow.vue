<template>
  <div class="exit-rule-row" :data-testid="`exit-rule-row-${index}`">
    <span class="row-index">{{ index + 1 }}</span>

    <!-- type 选择：已被其它行占用的 type 置灰（同 type 至多一条） -->
    <n-select
      :value="rule.type"
      :options="typeOptions"
      size="small"
      class="type-select"
      :data-testid="`exit-rule-type-${index}`"
      @update:value="onTypeChange"
    />

    <!-- 该 type 的 params（v1 每种 type 恰一个 param，但按数组渲染以兼容多 param） -->
    <div v-if="meta" class="params-wrap">
      <div
        v-for="p in meta.params"
        :key="p.name"
        class="param-item"
      >
        <span class="param-name">{{ p.name }}</span>
        <n-input-number
          :value="paramValue(p.name)"
          :min="numberMin(p)"
          :max="numberMax(p)"
          :step="p.valueType === 'int' ? 1 : 0.01"
          :precision="p.valueType === 'int' ? 0 : undefined"
          size="small"
          class="param-input"
          :status="paramInvalid(p) ? 'error' : undefined"
          :data-testid="`exit-rule-param-${index}-${p.name}`"
          @update:value="(v) => onParamChange(p.name, v)"
        />
        <span class="param-range">{{ rangeText(p) }}</span>
      </div>
    </div>
    <div v-else class="params-wrap params-unknown">未知规则类型</div>

    <div class="row-actions">
      <n-button
        size="tiny"
        quaternary
        :disabled="index === 0"
        title="上移"
        :data-testid="`exit-rule-up-${index}`"
        @click="emit('move-up', index)"
      >
        ↑
      </n-button>
      <n-button
        size="tiny"
        quaternary
        :disabled="index === total - 1"
        title="下移"
        :data-testid="`exit-rule-down-${index}`"
        @click="emit('move-down', index)"
      >
        ↓
      </n-button>
      <n-button
        size="tiny"
        quaternary
        type="error"
        title="删除"
        :data-testid="`exit-rule-remove-${index}`"
        @click="emit('remove', index)"
      >
        ✕
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInputNumber, NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import type {
  ExitRuleDef,
  ExitRuleType,
  ExitRuleParamMeta,
  ExitRuleTypeMeta,
} from '@cryptotrading/shared-types'
import { paramInRange, rangeText } from './exitRulesValidation'

interface TypeSelectOption extends SelectOption {
  label: string
  value: ExitRuleType
  disabled?: boolean
}

const props = defineProps<{
  rule: ExitRuleDef
  index: number
  total: number
  /** 全部 type 元信息（用于该行 type 下拉与渲染当前 type 的 param） */
  allMeta: ExitRuleTypeMeta[]
  /** 已被其它行占用的 type（含本行自身则不算，由父组件剔除本行） */
  usedTypes: ExitRuleType[]
}>()

const emit = defineEmits<{
  'update:rule': [value: ExitRuleDef]
  'move-up': [index: number]
  'move-down': [index: number]
  remove: [index: number]
}>()

const meta = computed<ExitRuleTypeMeta | undefined>(() =>
  props.allMeta.find((m) => m.type === props.rule.type),
)

const typeOptions = computed<TypeSelectOption[]>(() =>
  props.allMeta.map((m) => ({
    label: `${m.label}（${m.type}）`,
    value: m.type,
    // 已被其它行占用的 type 置灰，但当前行自身的 type 不禁用
    disabled: m.type !== props.rule.type && props.usedTypes.includes(m.type),
  })),
)

function paramValue(name: string): number | null {
  const v = props.rule.params[name]
  return typeof v === 'number' ? v : null
}

function paramInvalid(p: ExitRuleParamMeta): boolean {
  const v = props.rule.params[p.name]
  return typeof v !== 'number' || !paramInRange(v, p)
}

/** n-input-number 的 min/max 仅作软约束（开区间端点本身非法），真正校验在 validateExitRules */
function numberMin(p: ExitRuleParamMeta): number {
  return p.min
}
function numberMax(p: ExitRuleParamMeta): number {
  return p.max
}

function onTypeChange(newType: ExitRuleType) {
  const m = props.allMeta.find((x) => x.type === newType)
  const params: Record<string, number> = {}
  if (m) for (const p of m.params) params[p.name] = p.default
  emit('update:rule', { type: newType, params })
}

function onParamChange(name: string, v: number | null) {
  emit('update:rule', {
    type: props.rule.type,
    params: { ...props.rule.params, [name]: v ?? Number.NaN },
  })
}
</script>

<style scoped>
.exit-rule-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent);
  border-radius: 8px;
  margin-bottom: 6px;
}
.row-index {
  flex-shrink: 0;
  width: 18px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-muted);
}
.type-select {
  width: 180px;
  flex-shrink: 0;
}
.params-wrap {
  display: flex;
  gap: 14px;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
}
.params-unknown {
  font-size: 12px;
  color: var(--color-error);
}
.param-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.param-name {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.param-input {
  width: 120px;
}
.param-range {
  font-size: 11px;
  color: var(--color-text-muted);
}
.row-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
</style>
