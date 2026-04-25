<template>
  <n-form-item>
    <template #label>
      <LabelWithTip label="基础冷却根数" :max-width="280">
        回测启动时冷却时长的初始值；后续每次亏损按「亏损时冷却延长」增加、每次盈利按「盈利时冷却缩短」减少，在 [0, 最大冷却根数] 范围内变化
      </LabelWithTip>
    </template>
    <n-input-number v-model:value="params.baseCooldownCandles" :min="0" :max="200" style="width:100%" />
  </n-form-item>

  <n-form-item>
    <template #label>
      <LabelWithTip label="连亏触发阈值">
        账户连续亏损达到 N 次后，触发全局冷却期，暂停所有新开仓；盈利一笔即清零连亏计数
      </LabelWithTip>
    </template>
    <n-input-number v-model:value="params.consecutiveLossesThreshold" :min="1" :max="20" style="width:100%" />
  </n-form-item>

  <n-form-item>
    <template #label>
      <LabelWithTip label="最大冷却根数" :max-width="280">
        冷却时长的上限；亏损/盈利时增减冷却时长后不会超过此上限；冷却中每次亏损会按「亏损时冷却延长」延后结束、每次盈利按「盈利时冷却缩短」提前结束；时长降至 0 时立即解除冷却
      </LabelWithTip>
    </template>
    <n-input-number v-model:value="params.maxCooldownCandles" :min="1" :max="10000" style="width:100%" />
  </n-form-item>

  <n-form-item>
    <template #label>
      <LabelWithTip label="亏损时冷却延长（根）" :max-width="280">
        每次完整平仓亏损时：冷却时长增加若干根（不超过最大冷却根数）；若已在冷却期内，结束时间同步延后同等根数
      </LabelWithTip>
    </template>
    <n-input-number v-model:value="params.cooldownExtendOnLoss" :min="0" :max="10000" :precision="0" style="width:100%" />
  </n-form-item>

  <n-form-item>
    <template #label>
      <LabelWithTip label="盈利时冷却缩短（根）" :max-width="280">
        每次完整平仓盈利时：冷却时长减少若干根（不低于 0）；若已在冷却期内，结束时间同步提前同等根数；连亏计数仍会清零
      </LabelWithTip>
    </template>
    <n-input-number v-model:value="params.cooldownReduceOnProfit" :min="0" :max="10000" :precision="0" style="width:100%" />
  </n-form-item>
</template>

<script setup lang="ts">
import { NFormItem, NInputNumber } from 'naive-ui'
import LabelWithTip from '../LabelWithTip.vue'

import type { StrategyParams } from '../../../../composables/backtest/useStrategyForm'

defineProps<{ params: StrategyParams }>()
</script>
