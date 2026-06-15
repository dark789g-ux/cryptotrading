<!-- apps/web/src/components/strategy/RegimeRulesEditor.vue -->
<!--
  regime 调仓规则编辑器（账户级，组合模拟 + 迷你回测共用）。
  v-model 绑定 RegimeRule[]：每条 = 0AMV 条件构建器 + maxPositions(正整数) + positionRatio(0,1] + 删除。
  空列表 = 不启用（零漂移）；配了之后未命中市场状态当天不开仓（fail-closed 择时）。

  字段限制说明：ConditionRows 不支持限定可选字段集（只按 targetType 给全集），
  故用全 a-share 字段 + 顶部说明「仅大盘 0AMV 字段有效，其它字段后端会拒」，由后端
  validateRegimes 400 兜底（spec §8 备选方案）。
-->
<template>
  <div class="regime-editor">
    <div class="regime-editor__head">
      <span class="regime-editor__title">regime 调仓</span>
      <span class="regime-editor__hint">空 = 不启用，按顺序首个命中生效</span>
      <n-button size="tiny" type="primary" @click="addRule">+ 规则</n-button>
    </div>

    <div v-if="modelValue.length === 0" class="regime-editor__empty">
      未配置 regime = 不启用（走源静态 maxPositions / 单票仓位，零漂移）。
    </div>

    <div v-for="(rule, i) in modelValue" :key="i" class="regime-editor__rule">
      <div class="regime-editor__rule-head">
        <span class="regime-editor__rule-title">规则 {{ i + 1 }}</span>
        <n-button size="tiny" quaternary type="error" @click="removeRule(i)">删除</n-button>
      </div>

      <div class="regime-editor__cond-label">条件（大盘 0AMV，内部 AND）</div>
      <ConditionRows
        :conditions="rule.conditions"
        target-type="a-share"
        @update:conditions="(c) => onConditionsChange(i, c)"
      />

      <div class="regime-editor__nums">
        <div class="regime-editor__num">
          <span class="regime-editor__num-label">最大持仓</span>
          <n-input-number
            :value="rule.maxPositions"
            :min="1"
            :step="1"
            :precision="0"
            size="small"
            style="width: 120px"
            @update:value="(v) => patchRule(i, { maxPositions: posIntOr(v, rule.maxPositions) })"
          />
        </div>
        <div class="regime-editor__num">
          <span class="regime-editor__num-label">单票仓位</span>
          <n-input-number
            :value="rule.positionRatio"
            :min="0.01"
            :max="1"
            :step="0.01"
            size="small"
            style="width: 120px"
            @update:value="(v) => patchRule(i, { positionRatio: ratioOr(v, rule.positionRatio) })"
          />
        </div>
      </div>
    </div>

    <div v-if="modelValue.length > 0" class="regime-editor__warn">
      ⚠ 启用后未命中市场状态当天不开仓。仅大盘 0AMV 字段（0AMV-MACD-DIF / DEA / MACD、收盘、MA240）有效，
      其它字段或上穿/下穿算子后端会拒。
    </div>
  </div>
</template>

<script setup lang="ts">
import { NButton, NInputNumber } from 'naive-ui'
import ConditionRows from '../strategy-conditions/ConditionRows.vue'
import type { StrategyConditionItem } from '../../api/modules/strategy/strategyConditions'
import type { RegimeRule } from '../../api/modules/strategy/portfolioSim'

const props = defineProps<{
  /** 当前 regime 规则数组（[] = 不启用）。 */
  modelValue: RegimeRule[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', rules: RegimeRule[]): void
}>()

/** 新规则默认值：一条 0AMV 条件 + maxPositions=2 + positionRatio=0.2。 */
function freshRule(): RegimeRule {
  return {
    conditions: [
      { field: 'oamv_macd', operator: 'gt', value: 0, compareField: undefined, compareMode: 'value' },
    ],
    maxPositions: 2,
    positionRatio: 0.2,
  }
}

function emitRules(next: RegimeRule[]) {
  emit('update:modelValue', next)
}

function addRule() {
  emitRules([...props.modelValue, freshRule()])
}

function removeRule(i: number) {
  emitRules(props.modelValue.filter((_, idx) => idx !== i))
}

function patchRule(i: number, patch: Partial<RegimeRule>) {
  emitRules(props.modelValue.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
}

function onConditionsChange(i: number, conditions: StrategyConditionItem[]) {
  patchRule(i, { conditions })
}

/** null / 非正整数 → 回落 fallback，并向下取整保整数性（≥1）。 */
function posIntOr(v: number | null, fallback: number): number {
  if (v == null || !Number.isFinite(v)) return fallback
  const n = Math.floor(v)
  return n >= 1 ? n : fallback
}

/** positionRatio ∈ (0,1]，越界回落。 */
function ratioOr(v: number | null, fallback: number): number {
  if (v == null || !Number.isFinite(v)) return fallback
  if (v <= 0) return fallback
  if (v > 1) return 1
  return v
}
</script>

<style scoped>
.regime-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.regime-editor__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.regime-editor__title {
  font-size: 13px;
  font-weight: 600;
}

.regime-editor__hint {
  font-size: 11px;
  color: var(--color-text-muted, #aaa);
  flex: 1;
}

.regime-editor__empty {
  font-size: 12px;
  color: var(--color-text-muted, #aaa);
}

.regime-editor__rule {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--color-border, #e0e0e6);
  border-radius: 8px;
}

.regime-editor__rule-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.regime-editor__rule-title {
  font-size: 13px;
  font-weight: 600;
}

.regime-editor__cond-label {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
}

.regime-editor__nums {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}

.regime-editor__num {
  display: flex;
  align-items: center;
  gap: 8px;
}

.regime-editor__num-label {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
}

.regime-editor__warn {
  font-size: 11px;
  color: #f0a020;
  line-height: 1.5;
}
</style>
