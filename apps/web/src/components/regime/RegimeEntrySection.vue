<template>
  <div class="regime-entry-section">
    <n-divider>入场条件（个股级）</n-divider>
    <condition-rows
      :conditions="quadrant.entryConditions ?? []"
      target-type="a-share"
      default-operator="gt"
      default-compare-mode="value"
      @update:conditions="(v: StrategyConditionItem[]) => (quadrant.entryConditions = v)"
    />
  </div>
</template>

<script setup lang="ts">
import { NDivider } from 'naive-ui'
import ConditionRows from '@/components/strategy-conditions/ConditionRows.vue'
import type { StrategyConditionItem } from '@/api/modules/strategy/strategyConditions'
import type { QuadrantEntry } from '@/api/modules/strategy/regimeEngine'

defineProps<{
  quadrant: QuadrantEntry
}>()
</script>
