<template>
  <div class="section-card">
    <div class="section-title">资金与仓位</div>
    <n-form-item label="初始资金">
      <n-input-number v-model:value="params.initialCapital" :min="1000" :step="10000" style="width:100%" />
    </n-form-item>

    <n-form-item :label="positionRatioLabel">
      <n-slider v-model:value="params.positionRatio" :min="0.01" :max="1" :step="0.0001" />
      <div class="param-edit">
        <input class="param-input" v-model="positionPctDisplay" @change="commitPosition" @keydown.enter="blurInput" />
        <span class="param-suffix">%</span>
      </div>
    </n-form-item>

    <n-form-item label="最大持仓">
      <n-input-number
        v-model:value="params.maxPositions"
        :min="1"
        :max="20"
        :disabled="params.enableKellySizing"
      />
    </n-form-item>

    <n-form-item>
      <template #label>
        <LabelWithTip label="仅全部盈利时开新仓">
          开启后：当前所有持仓的止损价须已上移至成本之上（止损价 &gt; 入场价），才允许开新仓；空仓不受限
        </LabelWithTip>
      </template>
      <n-switch v-model:value="params.requireAllPositionsProfitable" />
    </n-form-item>

    <n-form-item>
      <template #label>
        <LabelWithTip label="启用凯利公式仓位管理">
          基于滑动窗口胜率与赔率动态计算每笔交易的最优仓位比例
        </LabelWithTip>
      </template>
      <n-switch v-model:value="params.enableKellySizing" />
    </n-form-item>

    <n-collapse v-if="params.enableKellySizing" :default-expanded-names="['kelly']">
      <n-collapse-item title="凯利公式参数" name="kelly">
        <n-form-item label="模拟期笔数">
          <n-input-number v-model:value="params.kellySimTrades" :min="0" :max="500" style="width:100%" />
        </n-form-item>

        <n-form-item label="滑动窗口大小">
          <n-input-number v-model:value="params.kellyWindowTrades" :min="1" :max="500" style="width:100%" />
        </n-form-item>

        <n-form-item label="统计更新步长">
          <n-input-number v-model:value="params.kellyStepTrades" :min="1" :max="100" style="width:100%" />
        </n-form-item>

        <n-form-item label="凯利分数">
          <n-slider v-model:value="params.kellyFraction" :min="0.10" :max="1" :step="0.01" />
          <div class="param-edit">
            <input class="param-input" v-model="kellyFractionDisplay" @change="commitKellyFraction" @keydown.enter="blurInput" />
          </div>
        </n-form-item>

        <n-form-item label="凯利仓位硬上限">
          <n-slider v-model:value="params.kellyMaxPositionRatio" :min="0.01" :max="1" :step="0.0001" />
          <div class="param-edit">
            <input class="param-input" v-model="kellyMaxDisplay" @change="commitKellyMax" @keydown.enter="blurInput" />
            <span class="param-suffix">%</span>
          </div>
        </n-form-item>

        <n-form-item>
          <template #label>
            <LabelWithTip label="凯利系数 ≤ 0 且空仓时启用探针交易">
              探针模式：当凯利系数非正且实盘空仓时，自动启用虚拟交易持续采样，以推动滑动窗口更新、打破死锁
            </LabelWithTip>
          </template>
          <n-switch v-model:value="params.enableKellyProbe" />
        </n-form-item>
      </n-collapse-item>
    </n-collapse>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NCollapse, NCollapseItem, NFormItem, NInputNumber, NSlider, NSwitch } from 'naive-ui'
import type { StrategyParams } from '../../../../composables/backtest/useStrategyForm'
import { useEditableNumber } from '../../../../composables/useEditableNumber'
import '../strategy-section.css'
import LabelWithTip from '../LabelWithTip.vue'

const params = defineModel<StrategyParams>('params', { required: true })

const positionRatioLabel = computed(() =>
  params.value.enableKellySizing ? '最大仓位上限' : '仓位比例'
)

const { display: positionPctDisplay, commit: commitPosition } = useEditableNumber(
  () => params.value.positionRatio,
  (v) => { params.value.positionRatio = v },
  { min: 0.01, max: 1, decimals: 2, scale: 100 }
)

const { display: kellyFractionDisplay, commit: commitKellyFraction } = useEditableNumber(
  () => params.value.kellyFraction,
  (v) => { params.value.kellyFraction = v },
  { min: 0.10, max: 1, decimals: 2, scale: 1 }
)

const { display: kellyMaxDisplay, commit: commitKellyMax } = useEditableNumber(
  () => params.value.kellyMaxPositionRatio,
  (v) => { params.value.kellyMaxPositionRatio = v },
  { min: 0.01, max: 1, decimals: 2, scale: 100 }
)

const blurInput = (e: KeyboardEvent) => {
  (e.target as HTMLInputElement).blur()
}
</script>

<style scoped>
.param-edit {
  display: inline-flex;
  align-items: center;
  margin-left: 12px;
  gap: 2px;
}
.param-input {
  width: 64px;
  text-align: right;
  background: transparent;
  color: var(--ember-text-secondary, var(--color-text-muted));
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 14px;
  padding: 2px 4px;
  outline: none;
  font-family: inherit;
  transition: border-color 150ms ease, box-shadow 150ms ease, color 150ms ease;
}
.param-input:hover {
  border-color: var(--ember-border, var(--color-border));
}
.param-input:focus {
  border-color: var(--ember-primary, var(--color-primary));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ember-primary, var(--color-primary)) 12%, transparent);
  color: var(--ember-text, var(--color-text));
}
.param-suffix {
  color: var(--ember-text-secondary, var(--color-text-muted));
  font-size: 14px;
}
</style>
