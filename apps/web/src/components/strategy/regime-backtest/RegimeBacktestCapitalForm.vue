<template>
  <div class="capital-form">
    <template v-if="showSizing">
      <n-form-item>
        <template #label>
          <LabelWithTip label="启用凯利公式仓位管理">
            基于滑动窗口胜率与赔率动态计算每笔交易的最优仓位比例
          </LabelWithTip>
        </template>
        <n-switch v-model:value="model.enableKellySizing" />
      </n-form-item>

      <n-collapse v-if="model.enableKellySizing" :default-expanded-names="['kelly']">
        <n-collapse-item title="凯利公式参数" name="kelly">
          <n-form-item label="模拟期笔数">
            <n-input-number v-model:value="model.simTrades" :min="0" :max="500" style="width: 280px" />
          </n-form-item>
          <n-form-item label="滑动窗口大小">
            <n-input-number v-model:value="model.windowTrades" :min="1" :max="500" style="width: 280px" />
          </n-form-item>
          <n-form-item label="统计更新步长">
            <n-input-number v-model:value="model.stepTrades" :min="1" :max="100" style="width: 280px" />
          </n-form-item>
          <n-form-item label="凯利分数">
            <n-slider v-model:value="model.kellyFraction" :min="0.1" :max="1" :step="0.01" style="width: 200px" />
            <div class="param-edit">
              <input
                class="param-input"
                v-model="kellyFractionDisplay"
                @change="commitKellyFraction"
                @keydown.enter="blurInput"
              />
            </div>
          </n-form-item>
          <n-form-item label="凯利乘子上限">
            <n-slider v-model:value="model.kellyMaxMult" :min="0.01" :max="1" :step="0.01" style="width: 200px" />
            <div class="param-edit">
              <input
                class="param-input"
                v-model="kellyMaxDisplay"
                @change="commitKellyMax"
                @keydown.enter="blurInput"
              />
            </div>
          </n-form-item>
          <n-form-item>
            <template #label>
              <LabelWithTip label="凯利系数 ≤ 0 且空仓时启用探针交易">
                探针模式：当凯利系数非正且实盘空仓时，自动启用虚拟交易持续采样，以推动滑动窗口更新、打破死锁
              </LabelWithTip>
            </template>
            <n-switch v-model:value="model.enableProbe" />
          </n-form-item>
        </n-collapse-item>
      </n-collapse>
    </template>

    <template v-if="showRisk">
      <n-form-item>
        <template #label>
          <LabelWithTip label="连亏熔断">
            账户连续亏损达到阈值后触发全局冷却期，暂停所有新开仓
          </LabelWithTip>
        </template>
        <n-switch v-model:value="model.enableCooldown" />
      </n-form-item>
      <template v-if="model.enableCooldown">
        <n-form-item label="连亏触发阈值">
          <n-input-number
            v-model:value="model.consecutiveLossesThreshold"
            :min="1"
            :max="20"
            style="width: 280px"
          />
        </n-form-item>
        <n-form-item label="基础冷却天数">
          <n-input-number v-model:value="model.baseCooldownDays" :min="0" :max="200" style="width: 280px" />
        </n-form-item>
        <n-form-item label="最大冷却天数">
          <n-input-number v-model:value="model.maxCooldownDays" :min="1" :max="10000" style="width: 280px" />
        </n-form-item>
        <n-form-item label="亏损时延长天数">
          <n-input-number v-model:value="model.extendOnLoss" :min="0" :max="10000" style="width: 280px" />
        </n-form-item>
        <n-form-item label="盈利时缩短天数">
          <n-input-number v-model:value="model.reduceOnProfit" :min="0" :max="10000" style="width: 280px" />
        </n-form-item>
      </template>

      <n-form-item>
        <template #label>
          <LabelWithTip label="回撤熔断">
            账户净值自峰值回撤达到阈值后停开仓，回升到恢复线后解除
          </LabelWithTip>
        </template>
        <n-switch v-model:value="model.enableDrawdownHalt" />
      </n-form-item>
      <template v-if="model.enableDrawdownHalt">
        <n-form-item label="停开仓回撤阈值">
          <n-slider
            v-model:value="model.drawdownHaltPct"
            :min="0.01"
            :max="0.5"
            :step="0.01"
            style="width: 200px"
          />
          <div class="param-edit">
            <input
              class="param-input"
              v-model="haltPctDisplay"
              @change="commitHaltPct"
              @keydown.enter="blurInput"
            />
            <span class="param-suffix">%</span>
          </div>
        </n-form-item>
        <n-form-item label="恢复开仓回撤阈值">
          <n-slider
            v-model:value="model.drawdownResumePct"
            :min="0"
            :max="model.drawdownHaltPct"
            :step="0.01"
            style="width: 200px"
          />
          <div class="param-edit">
            <input
              class="param-input"
              v-model="resumePctDisplay"
              @change="commitResumePct"
              @keydown.enter="blurInput"
            />
            <span class="param-suffix">%</span>
          </div>
        </n-form-item>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  NCollapse,
  NCollapseItem,
  NFormItem,
  NInputNumber,
  NSlider,
  NSwitch,
} from 'naive-ui'
import LabelWithTip from '@/components/backtest/strategy/LabelWithTip.vue'
import { useEditableNumber } from '@/composables/hooks/useEditableNumber'
import type { RegimeCapitalFormState } from './regimeCapitalForm'

const props = withDefaults(
  defineProps<{
    /** sizing=Kelly；risk=连亏/回撤熔断；all=全部（兼容旧用法） */
    section?: 'sizing' | 'risk' | 'all'
  }>(),
  { section: 'all' },
)

const model = defineModel<RegimeCapitalFormState>({ required: true })

const showSizing = computed(() => props.section === 'all' || props.section === 'sizing')
const showRisk = computed(() => props.section === 'all' || props.section === 'risk')

const { display: kellyFractionDisplay, commit: commitKellyFraction } = useEditableNumber(
  () => model.value.kellyFraction,
  (v) => { model.value.kellyFraction = v },
  { min: 0.1, max: 1, decimals: 2, scale: 1 },
)

const { display: kellyMaxDisplay, commit: commitKellyMax } = useEditableNumber(
  () => model.value.kellyMaxMult,
  (v) => { model.value.kellyMaxMult = v },
  { min: 0.01, max: 1, decimals: 2, scale: 1 },
)

const { display: haltPctDisplay, commit: commitHaltPct } = useEditableNumber(
  () => model.value.drawdownHaltPct,
  (v) => {
    model.value.drawdownHaltPct = v
    if (model.value.drawdownResumePct > v) {
      model.value.drawdownResumePct = v
    }
  },
  { min: 0.01, max: 0.5, decimals: 0, scale: 100 },
)

const { display: resumePctDisplay, commit: commitResumePct } = useEditableNumber(
  () => model.value.drawdownResumePct,
  (v) => { model.value.drawdownResumePct = v },
  { min: 0, max: model.value.drawdownHaltPct, decimals: 0, scale: 100 },
)

const blurInput = (e: KeyboardEvent) => {
  (e.target as HTMLInputElement).blur()
}
</script>

<style scoped>
.capital-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

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
  color: var(--n-text-color-2);
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 14px;
  padding: 2px 4px;
  outline: none;
  font-family: inherit;
}

.param-input:hover {
  border-color: var(--n-border-color);
}

.param-input:focus {
  border-color: var(--n-primary-color);
  color: var(--n-text-color);
}

.param-suffix {
  color: var(--n-text-color-3);
  font-size: 14px;
}
</style>
