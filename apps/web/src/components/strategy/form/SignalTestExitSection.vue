<template>
  <div>
    <n-form-item label="出场模式">
      <n-radio-group
        :value="model.exitMode"
        @update:value="(v: SignalTestExitMode) => patch({ exitMode: v })"
      >
        <n-radio value="fixed_n">固定 N 个交易日</n-radio>
        <n-radio value="strategy">卖出条件命中</n-radio>
        <n-radio value="trailing_lock">波段跟踪止损</n-radio>
        <n-radio value="phase_lock">两阶段锁定止损</n-radio>
      </n-radio-group>
    </n-form-item>

    <template v-if="model.exitMode === 'fixed_n'">
      <n-form-item
        label="持有天数 N"
        path="horizonN"
        :rule="{ type: 'number', required: true, min: 1, message: '请输入 ≥1 的正整数' }"
      >
        <n-input-number
          :value="model.horizonN"
          :min="1"
          :precision="0"
          style="width: 140px"
          @update:value="(v: number | null) => patch({ horizonN: v })"
        />
      </n-form-item>
    </template>

    <template v-else-if="model.exitMode === 'strategy'">
      <n-divider dashed>卖出条件</n-divider>
      <condition-rows
        :conditions="model.exitConditions"
        target-type="a-share"
        default-operator="gt"
        @update:conditions="(v: StrategyConditionItem[]) => patch({ exitConditions: v })"
      />
      <n-form-item
        label="最长持有天数兜底"
        path="maxHold"
        :rule="{ type: 'number', required: true, min: 1, message: '请输入 ≥1 的正整数' }"
      >
        <n-input-number
          :value="model.maxHold"
          :min="1"
          :precision="0"
          style="width: 140px"
          @update:value="(v: number | null) => patch({ maxHold: v })"
        />
      </n-form-item>
    </template>

    <template v-else-if="model.exitMode === 'trailing_lock'">
      <n-divider dashed>波段跟踪止损参数</n-divider>
      <n-form-item
        label="最长持有天数（可选，留空不封顶）"
        path="maxHold"
        :rule="{ type: 'number', min: 1, message: '请输入 ≥1 的正整数' }"
      >
        <n-input-number
          :value="model.maxHold"
          :min="1"
          :precision="0"
          clearable
          placeholder="留空不封顶"
          style="width: 200px"
          @update:value="(v: number | null) => patch({ maxHold: v })"
        />
      </n-form-item>

      <n-form-item>
        <template #label>
          <label-with-tip label="止损缓冲系数" :max-width="300">
            止损价 = 跟踪低点 × 该系数。留空走默认 0.999；范围 (0,1]，量化到 0.001。
            越小止损越宽松，越接近 1 越贴近跟踪低点。
          </label-with-tip>
        </template>
        <n-input-number
          :value="model.stopRatio"
          :min="0.001"
          :max="1"
          :step="0.001"
          :precision="3"
          style="width: 200px"
          @update:value="(v: number | null) => patch({ stopRatio: v ?? 0.999 })"
        />
      </n-form-item>

      <n-form-item>
        <template #label>
          <label-with-tip label="启用成本地板" :max-width="300">
            开启后止损价不低于「成本价 × 地板系数」，可在回暖前锁住本金/锁盈。关闭则仅按跟踪低点止损。
          </label-with-tip>
        </template>
        <n-switch
          :value="model.floorEnabled"
          @update:value="(v: boolean) => patch({ floorEnabled: v })"
        />
      </n-form-item>

      <n-form-item>
        <template #label>
          <label-with-tip label="成本地板系数" :max-width="300">
            成本地板 = 成本价 × 该系数。留空走默认 0.999；范围 [0.001,9.999]，允许 &gt; 1（锁盈）。
            量化到 0.001。仅在「启用成本地板」开启时生效。
          </label-with-tip>
        </template>
        <n-input-number
          :value="model.floorRatio"
          :min="0.001"
          :step="0.001"
          :precision="3"
          :disabled="!model.floorEnabled"
          style="width: 200px"
          @update:value="(v: number | null) => patch({ floorRatio: v ?? 0.999 })"
        />
      </n-form-item>

      <n-form-item>
        <template #label>
          <label-with-tip label="MA5 需下行才离场" :max-width="300">
            锁定后触发 MA5 离场时，是否要求 MA5 同时下行才离场。留空走默认开启；
            关闭则收盘价跌破 MA5 即离场（更敏感）。
          </label-with-tip>
        </template>
        <n-switch
          :value="model.ma5RequireDown"
          @update:value="(v: boolean) => patch({ ma5RequireDown: v })"
        />
      </n-form-item>
    </template>

    <template v-else-if="model.exitMode === 'phase_lock'">
      <n-divider dashed>两阶段锁定止损参数</n-divider>
      <div class="exit__hint">初始止损回看根数已移至「基础配置」tab。</div>
      <n-form-item>
        <template #label>
          <label-with-tip label="初始止损系数" :max-width="320">
            初始止损价 = min(回看低点) × 该系数，阶段 A 固定不上移。留空走默认 0.999；
            范围 (0,2]，量化到 0.001。越小止损越宽松。
          </label-with-tip>
        </template>
        <n-input-number
          :value="model.initFactor"
          :min="0.001"
          :max="2"
          :step="0.001"
          :precision="3"
          placeholder="0.999"
          style="width: 200px"
          @update:value="(v: number | null) => patch({ initFactor: v ?? 0.999 })"
        />
      </n-form-item>

      <n-form-item>
        <template #label>
          <label-with-tip label="锁定止损系数" :max-width="320">
            锁定止损价 = max(成本价, 当日低点) × 该系数（收盘站上 MA5↑ 后冻结）。留空走默认 0.999；
            范围 (0,2]，允许 &gt; 1（锁盈），量化到 0.001。
          </label-with-tip>
        </template>
        <n-input-number
          :value="model.lockFactor"
          :min="0.001"
          :max="2"
          :step="0.001"
          :precision="3"
          placeholder="0.999"
          style="width: 200px"
          @update:value="(v: number | null) => patch({ lockFactor: v ?? 0.999 })"
        />
      </n-form-item>
    </template>
  </div>
</template>

<script setup lang="ts">
import { NFormItem, NInputNumber, NRadioGroup, NRadio, NSwitch, NDivider } from 'naive-ui'
import ConditionRows from '../../strategy-conditions/ConditionRows.vue'
import LabelWithTip from '../../backtest/strategy/LabelWithTip.vue'
import type { StrategyConditionItem } from '../../../api/modules/strategy/strategyConditions'
import type { SignalTestExitMode } from '../../../api/modules/strategy/signalStats'
import type { SignalTestFormModel } from '../../../composables/strategy/useSignalTestForm'

defineProps<{
  model: SignalTestFormModel
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<SignalTestFormModel>): void
}>()

function patch(p: Partial<SignalTestFormModel>) {
  emit('update', p)
}
</script>

<style scoped>
.exit__hint {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--color-text-muted, #aaa);
}
</style>
