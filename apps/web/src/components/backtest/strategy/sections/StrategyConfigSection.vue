<template>
  <div class="section-card">
    <div class="section-title">基础配置</div>
    <n-form-item>
      <template #label>
        <LabelWithTip label="低点扫描(K线)" :max-width="260">
          向前取最近 N 根 K 线的最低价作为阶段低点候选；影响止损基准价和入场距低点判断
        </LabelWithTip>
      </template>
      <n-input-number v-model:value="params.recentLowWindow" :min="1" :max="200" style="width:100%" />
    </n-form-item>

    <n-form-item>
      <template #label>
        <LabelWithTip label="低点追溯缓冲" :max-width="260">
          在扫描窗口之外继续向前追溯最多 Y 根 K 线：若找到更低点则更新阶段低点并继续追溯，直到无更低点为止
        </LabelWithTip>
      </template>
      <n-input-number v-model:value="params.recentLowBuffer" :min="0" :max="500" style="width:100%" />
    </n-form-item>

    <n-form-item>
      <template #label>
        <LabelWithTip label="高点窗口(K线)">
          计算阶段高点时，向前取最近 N 根 K 线的最高价作为初始候选，影响止盈目标价
        </LabelWithTip>
      </template>
      <n-input-number v-model:value="params.recentHighWindow" :min="1" :max="50" style="width:100%" />
    </n-form-item>

    <n-form-item>
      <template #label>
        <LabelWithTip label="高点回溯缓冲">
          在窗口之外继续向前追溯，找更高的连续高点；增大可找到更远的阻力位
        </LabelWithTip>
      </template>
      <n-input-number v-model:value="params.recentHighBuffer" :min="0" :max="500" style="width:100%" />
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { NFormItem, NInputNumber } from 'naive-ui'
import type { StrategyParams } from '../../../../composables/backtest/useStrategyForm'
import '../strategy-section.css'
import LabelWithTip from '../LabelWithTip.vue'

const params = defineModel<StrategyParams>('params', { required: true })
</script>
