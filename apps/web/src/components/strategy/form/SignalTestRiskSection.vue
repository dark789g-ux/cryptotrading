<template>
  <div>
    <!-- 启用回测层总开关 -->
    <n-form-item>
      <template #label>
        <label-with-tip label="启用迷你回测层" :max-width="320">
          关闭 = 仅跑信号质量层（胜率/凯利/盈亏比），与存量行为零漂移。
          开启 = 额外用资金账户引擎回放出净值曲线（资金/仓位/排序/熔断/成本生效）。
        </label-with-tip>
      </template>
      <n-switch
        :value="model.enableBacktest"
        @update:value="(v: boolean) => patch({ enableBacktest: v })"
      />
    </n-form-item>

    <template v-if="model.enableBacktest">
      <n-form-item>
        <template #label>
          <label-with-tip label="锚点模式 anchorMode" :max-width="320">
            约束停用、费率全 0、每笔必成交（对账用）。开启时熔断/成本/约束全旁路。
          </label-with-tip>
        </template>
        <n-switch
          :value="model.btAnchorMode"
          @update:value="(v: boolean) => patch({ btAnchorMode: v })"
        />
      </n-form-item>

      <n-divider>成本档</n-divider>
      <n-form-item label="费率预设">
        <n-select
          :value="costTier"
          :options="costTierOptions"
          :disabled="model.btAnchorMode"
          style="width: 240px"
          @update:value="onCostTierChange"
        />
        <span class="risk__rate-hint">{{ rateHint }}</span>
      </n-form-item>

      <n-divider>双触发熔断</n-divider>
      <CircuitBreakerPanel
        :model="model.btCircuitBreaker"
        :disabled="model.btAnchorMode"
        :anchor-mode="model.btAnchorMode"
        @update="(p) => patch({ btCircuitBreaker: { ...model.btCircuitBreaker, ...p } })"
      />
    </template>

    <div v-else class="risk__off-hint">
      未启用回测层。仅信号质量层结果（胜率/凯利/盈亏比/直方图）。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NFormItem, NSwitch, NSelect, NDivider } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import CircuitBreakerPanel from '../../portfolio-sim/CircuitBreakerPanel.vue'
import LabelWithTip from '../../backtest/strategy/LabelWithTip.vue'
import {
  COST_TIER_PRESETS,
  COST_TIER_LABELS,
  estimateRoundTripRate,
  formatRatePct,
  type CostTier,
} from '../../portfolio-sim/portfolioSimPresets'
import type { PortfolioSimCostRates } from '../../../api/modules/strategy/portfolioSim'
import type { SignalTestFormModel } from '../../../composables/strategy/useSignalTestForm'

const props = defineProps<{
  model: SignalTestFormModel
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<SignalTestFormModel>): void
}>()

function patch(p: Partial<SignalTestFormModel>) {
  emit('update', p)
}

// 当前选中的费率档：从 model.btCost 反推；改不出预设即 'custom'。
const costTier = ref<CostTier>(matchTier(props.model.btCost))

watch(
  () => props.model.btCost,
  (c) => {
    costTier.value = matchTier(c)
  },
  { deep: true },
)

function matchTier(c: PortfolioSimCostRates): CostTier {
  for (const [tier, preset] of Object.entries(COST_TIER_PRESETS)) {
    if (sameCost(c, preset)) return tier as CostTier
  }
  return 'custom'
}

function sameCost(a: PortfolioSimCostRates, b: PortfolioSimCostRates): boolean {
  return (
    a.commissionPerSide === b.commissionPerSide &&
    a.transferPerSide === b.transferPerSide &&
    a.stampSellBefore20230828 === b.stampSellBefore20230828 &&
    a.stampSellFrom20230828 === b.stampSellFrom20230828 &&
    a.slippagePerSide === b.slippagePerSide
  )
}

const costTierOptions: SelectOption[] = (
  Object.keys(COST_TIER_PRESETS) as Array<Exclude<CostTier, 'custom'>>
).map((tier) => ({ label: COST_TIER_LABELS[tier], value: tier }))

function onCostTierChange(tier: CostTier) {
  if (tier === 'custom') return
  patch({ btCost: { ...COST_TIER_PRESETS[tier] } })
}

const rateHint = computed(
  () => `双边合计约 ${formatRatePct(estimateRoundTripRate(props.model.btCost))}`,
)
</script>

<style scoped>
.risk__rate-hint {
  margin-left: 12px;
  font-size: 12px;
  color: var(--color-text-muted, #aaa);
}

.risk__off-hint {
  padding: 16px 12px;
  font-size: 13px;
  color: var(--color-text-muted, #aaa);
}
</style>
