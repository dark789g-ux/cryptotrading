<template>
  <n-form-item label="排序模式">
    <n-radio-group v-model:value="params.entrySortMode">
      <n-space>
        <n-radio value="single">单因子排序</n-radio>
        <n-radio value="composite">多因子加权</n-radio>
      </n-space>
    </n-radio-group>
  </n-form-item>

  <n-divider />

  <div class="factor-list">
    <div
      v-for="(item, idx) in params.entrySortFactors"
      :key="item.factor"
      class="factor-row"
      :class="{ disabled: !canEnable(item.factor) }"
    >
      <div class="factor-main">
        <n-switch
          v-model:value="item.enabled"
          @update:value="(v: boolean) => handleEnableChange(idx, v)"
        />
        <span class="factor-name">{{ FACTOR_LABELS[item.factor] }}</span>
      </div>

      <div class="factor-config">
        <n-form-item label="方向" :show-feedback="false" size="small">
          <n-select
            v-model:value="item.direction"
            :options="directionOptions"
            size="small"
            style="width:90px"
          />
        </n-form-item>

        <n-form-item
          v-if="params.entrySortMode === 'composite'"
          label="权重"
          :show-feedback="false"
          size="small"
        >
          <n-slider v-model:value="item.weight" :min="0" :max="1" :step="0.01" style="width:120px" />
          <span class="weight-value">{{ item.weight.toFixed(2) }}</span>
        </n-form-item>

        <n-form-item
          v-if="item.factor === 'momentum'"
          label="MA周期"
          :show-feedback="false"
          size="small"
        >
          <n-select
            :value="(item.params?.maPeriod as number) ?? 5"
            :options="maPeriodOptions"
            size="small"
            style="width:90px"
            @update:value="(v: number) => { item.params = { ...(item.params ?? {}), maPeriod: v } }"
          />
        </n-form-item>
      </div>
    </div>
  </div>

  <n-alert v-if="params.entrySortMode === 'composite'" type="info" :show-icon="false" style="margin-top:12px">
    多因子加权模式下，各因子按权重计算综合得分后排序。当前仅「盈亏比」因子已实现，其余因子为预留扩展。
  </n-alert>
</template>

<script setup lang="ts">
import {
  NFormItem,
  NRadioGroup,
  NRadio,
  NSpace,
  NSwitch,
  NSelect,
  NSlider,
  NTag,
  NAlert,
  NDivider,
} from 'naive-ui'
import type { StrategyParams, SortFactorType } from '../../../composables/backtest/useStrategyForm'

const props = defineProps<{ params: StrategyParams }>()

const FACTOR_LABELS: Record<SortFactorType, string> = {
  risk_reward: '盈亏比',
  momentum: '动量强度',
  freshness: '信号新鲜度',
  liquidity: '流动性',
  volatility: '波动率适配',
}

const directionOptions = [
  { label: '降序', value: 'desc' },
  { label: '升序', value: 'asc' },
]

const maPeriodOptions = [
  { label: 'MA5', value: 5 },
  { label: 'MA30', value: 30 },
  { label: 'MA60', value: 60 },
  { label: 'MA120', value: 120 },
  { label: 'MA240', value: 240 },
]

function canEnable(_factor: SortFactorType): boolean {
  return true
}

function handleEnableChange(idx: number, val: boolean): void {
  if (!val) return
  // single 模式下，启用新因子时自动禁用其他因子
  if (props.params.entrySortMode === 'single') {
    props.params.entrySortFactors.forEach((f, i) => {
      if (i !== idx) f.enabled = false
    })
  }
}
</script>

<style scoped>
.factor-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.factor-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--n-border-color);
  border-radius: 6px;
}

.factor-row.disabled {
  opacity: 0.6;
  background: var(--n-action-color);
}

.factor-main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.factor-name {
  font-weight: 500;
  min-width: 80px;
}

.factor-config {
  display: flex;
  gap: 16px;
  padding-left: 50px;
}

.weight-value {
  min-width: 36px;
  text-align: right;
  font-size: 12px;
  color: var(--n-text-color-3);
}
</style>
