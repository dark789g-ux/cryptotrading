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
    >
      <div class="factor-main">
        <n-switch
          v-model:value="item.enabled"
          @update:value="(v: boolean) => handleEnableChange(idx, v)"
        />
        <LabelWithTip :label="FACTOR_LABELS[item.factor]" :max-width="320">
          {{ FACTOR_TIPS[item.factor] }}
        </LabelWithTip>
      </div>

      <div class="factor-config">
        <div class="factor-config-left">
          <n-form-item label="方向" :show-feedback="false" size="small">
            <n-select
              v-model:value="item.direction"
              :options="directionOptions"
              size="small"
              style="width:90px"
            />
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

          <n-form-item
            v-if="item.factor === 'liquidity'"
            label="均值根数"
            :show-feedback="false"
            size="small"
          >
            <n-input-number
              :value="(item.params?.window as number) ?? 5"
              :min="1"
              :max="50"
              size="small"
              style="width:90px"
              @update:value="(v: number) => { item.params = { ...(item.params ?? {}), window: v } }"
            />
          </n-form-item>
        </div>

        <div
          v-if="params.entrySortMode === 'composite'"
          class="factor-config-right"
        >
          <n-form-item label="权重" :show-feedback="false" size="small">
            <div class="weight-input">
              <n-slider
                v-model:value="item.weight"
                :min="0"
                :max="1"
                :step="0.01"
                style="width:100px"
              />
              <n-input-number
                v-model:value="item.weight"
                :min="0"
                :max="1"
                :step="0.01"
                size="small"
                style="width:70px"
              />
            </div>
          </n-form-item>
        </div>
      </div>
    </div>
  </div>

  <n-alert v-if="params.entrySortMode === 'composite'" type="info" :show-icon="false" style="margin-top:12px">
    多因子加权模式下，各因子按权重计算综合得分后排序。
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
  NInputNumber,
  NAlert,
  NDivider,
} from 'naive-ui'
import LabelWithTip from '../LabelWithTip.vue'
import type { StrategyParams, SortFactorType } from '../../../../composables/backtest/useStrategyForm'

const props = defineProps<{ params: StrategyParams }>()

const FACTOR_LABELS: Record<SortFactorType, string> = {
  risk_reward: '盈亏比',
  momentum: '动量强度',
  freshness: '信号新鲜度',
  liquidity: '流动性',
  volatility: '波动率适配',
}

const FACTOR_TIPS: Record<SortFactorType, string> = {
  risk_reward: '(高点 - 收盘价) / (收盘价 - 低点)，衡量潜在收益与风险的比例',
  momentum: '(收盘价 - MA周期) / ATR14，衡量短期趋势强度相对于波动率',
  freshness: 'J 值进入超卖区以来的 K 线根数倒数，越新鲜得分越高',
  liquidity: '最近 window 根 K 线计价币成交额的均值，衡量标的成交活跃程度',
  volatility: '收盘价 / ATR14，波动率相对越低，信号越稳健',
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

function handleEnableChange(idx: number, val: boolean): void {
  if (!val) return
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
  justify-content: space-between;
  align-items: center;
  padding-left: 50px;
}

.factor-config-left {
  display: flex;
  gap: 16px;
}

.factor-config-right {
  display: flex;
  justify-content: flex-end;
}

.weight-input {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
