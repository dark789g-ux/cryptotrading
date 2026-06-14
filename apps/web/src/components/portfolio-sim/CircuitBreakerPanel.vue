<template>
  <div class="cb">
    <div v-if="anchorMode" class="cb__anchor-hint">
      锚点模式下熔断被强制全旁路（提交时不下发 circuitBreaker）。
    </div>

    <!-- 连亏熔断组 -->
    <div class="cb__group">
      <div class="cb__group-head">
        <n-switch
          :value="model.enableCooldown"
          size="small"
          :disabled="disabled"
          @update:value="(v: boolean) => patch({ enableCooldown: v })"
        />
        <span class="cb__group-title">连亏熔断 cooldown</span>
        <span class="cb__group-hint">连亏 N 笔后冻结开仓一段交易日</span>
      </div>
      <div v-if="model.enableCooldown" class="cb__fields">
        <div class="cb__field">
          <span class="cb__sub">连亏 N 笔触发（≥1 整数）</span>
          <n-input-number
            :value="model.consecutiveLossesThreshold"
            :min="1"
            :step="1"
            :precision="0"
            size="small"
            :disabled="disabled"
            style="width: 120px"
            @update:value="(v: number | null) => patch({ consecutiveLossesThreshold: intOr(v, 1) })"
          />
        </div>
        <div class="cb__field">
          <span class="cb__sub">基础冷却天数 base</span>
          <n-input-number
            :value="model.baseCooldownDays"
            :min="0"
            :step="1"
            :precision="0"
            size="small"
            :disabled="disabled"
            style="width: 120px"
            @update:value="(v: number | null) => patch({ baseCooldownDays: intOr(v, 0) })"
          />
        </div>
        <div class="cb__field">
          <span class="cb__sub">冷却上限 max（≥base）</span>
          <n-input-number
            :value="model.maxCooldownDays"
            :min="model.baseCooldownDays"
            :step="1"
            :precision="0"
            size="small"
            :disabled="disabled"
            style="width: 120px"
            @update:value="(v: number | null) => patch({ maxCooldownDays: intOr(v, model.baseCooldownDays) })"
          />
        </div>
        <div class="cb__field">
          <span class="cb__sub">每次亏损延长 extend</span>
          <n-input-number
            :value="model.extendOnLoss"
            :min="0"
            :step="1"
            :precision="0"
            size="small"
            :disabled="disabled"
            style="width: 120px"
            @update:value="(v: number | null) => patch({ extendOnLoss: intOr(v, 0) })"
          />
        </div>
        <div class="cb__field">
          <span class="cb__sub">每次盈利缩短 reduce</span>
          <n-input-number
            :value="model.reduceOnProfit"
            :min="0"
            :step="1"
            :precision="0"
            size="small"
            :disabled="disabled"
            style="width: 120px"
            @update:value="(v: number | null) => patch({ reduceOnProfit: intOr(v, 0) })"
          />
        </div>
      </div>
    </div>

    <!-- 回撤熔断组 -->
    <div class="cb__group">
      <div class="cb__group-head">
        <n-switch
          :value="model.enableDrawdownHalt"
          size="small"
          :disabled="disabled"
          @update:value="(v: boolean) => patch({ enableDrawdownHalt: v })"
        />
        <span class="cb__group-title">回撤熔断 drawdown</span>
        <span class="cb__group-hint">自峰值回撤超阈值停开仓，回升至复位阈值恢复（滞回）</span>
      </div>
      <div v-if="model.enableDrawdownHalt" class="cb__fields">
        <div class="cb__field">
          <span class="cb__sub">停于回撤 ≥（0,1）</span>
          <n-input-number
            :value="model.drawdownHaltPct"
            :min="0.0001"
            :max="0.9999"
            :step="0.01"
            size="small"
            :disabled="disabled"
            style="width: 120px"
            @update:value="(v: number | null) => patch({ drawdownHaltPct: haltOr(v) })"
          />
        </div>
        <div class="cb__field">
          <span class="cb__sub">复于回撤 ≤（≤停阈值）</span>
          <n-input-number
            :value="model.drawdownResumePct"
            :min="0"
            :max="model.drawdownHaltPct"
            :step="0.01"
            size="small"
            :disabled="disabled"
            style="width: 120px"
            @update:value="(v: number | null) => patch({ drawdownResumePct: resumeOr(v) })"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NInputNumber, NSwitch } from 'naive-ui'
import type { CircuitBreaker } from '../../api/modules/strategy/portfolioSim'

const props = defineProps<{
  model: CircuitBreaker
  disabled: boolean
  anchorMode: boolean
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<CircuitBreaker>): void
}>()

function patch(p: Partial<CircuitBreaker>) {
  emit('update', p)
}

/** null / 非整 → 回落 fallback，并向下取整保整数性。 */
function intOr(v: number | null, fallback: number): number {
  if (v == null || !Number.isFinite(v)) return fallback
  return Math.floor(v)
}

/** drawdownHaltPct ∈ (0,1)，越界回落。 */
function haltOr(v: number | null): number {
  if (v == null || !Number.isFinite(v)) return props.model.drawdownHaltPct
  if (v <= 0) return 0.0001
  if (v >= 1) return 0.9999
  return v
}

/** drawdownResumePct ∈ [0, haltPct]，越界回落。 */
function resumeOr(v: number | null): number {
  if (v == null || !Number.isFinite(v)) return props.model.drawdownResumePct
  if (v < 0) return 0
  if (v > props.model.drawdownHaltPct) return props.model.drawdownHaltPct
  return v
}
</script>

<style scoped>
.cb {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cb__anchor-hint {
  font-size: 12px;
  color: var(--color-text-muted, #aaa);
}

.cb__group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--color-border, #e0e0e6);
  border-radius: 8px;
}

.cb__group-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cb__group-title {
  font-size: 13px;
  font-weight: 600;
}

.cb__group-hint {
  font-size: 11px;
  color: var(--color-text-muted, #aaa);
}

.cb__fields {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

.cb__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cb__sub {
  font-size: 11px;
  color: var(--color-text-secondary, #888);
}
</style>
