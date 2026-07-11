<template>
  <div class="regime-exit-section">
    <n-divider>出场设置</n-divider>
    <n-form label-placement="left" label-width="80">
      <n-form-item label="出场模式">
        <n-select
          :value="quadrant.exitMode"
          :options="EXIT_MODE_OPTIONS"
          clearable
          placeholder="选择出场模式"
          style="width: 200px"
          @update:value="(v: string | null) => setExitMode(v)"
        />
      </n-form-item>

      <trailing-lock-params-form
        v-if="quadrant.exitMode === 'trailing_lock' && quadrant.exitParams"
        :params="hydrateTrailingLockParams(quadrant.exitParams)"
        @update:params="(v) => (quadrant.exitParams = asExitParamsRecord(v))"
      />

      <template v-else-if="quadrant.exitMode === 'fixed_n'">
        <n-form-item label="N（天数）">
          <n-input-number
            :value="(quadrant.exitParams?.N as number | undefined)"
            :min="1"
            placeholder="正整数"
            style="width: 160px"
            @update:value="(v: number | null) => setExitParam('N', v)"
          />
        </n-form-item>
      </template>

      <template v-else-if="quadrant.exitMode === 'strategy'">
        <n-form-item label="退出条件">
          <condition-rows
            :conditions="(quadrant.exitParams?.exitConditions as StrategyConditionItem[] ?? [])"
            target-type="a-share"
            default-operator="lt"
            default-compare-mode="value"
            @update:conditions="(v: StrategyConditionItem[]) => setExitParam('exitConditions', v)"
          />
        </n-form-item>
        <n-form-item label="maxHold">
          <n-input-number
            :value="(quadrant.exitParams?.maxHold as number | null ?? null)"
            :min="1"
            placeholder="必填"
            style="width: 160px"
            @update:value="(v: number | null) => setExitParam('maxHold', v)"
          />
        </n-form-item>
      </template>
    </n-form>
  </div>
</template>

<script setup lang="ts">
import { NForm, NFormItem, NInputNumber, NSelect, NDivider } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import ConditionRows from '@/components/strategy-conditions/ConditionRows.vue'
import TrailingLockParamsForm from '@/components/regime/TrailingLockParamsForm.vue'
import {
  asExitParamsRecord,
  hydrateTrailingLockParams,
} from '@/components/regime/trailingLockParams'
import type { StrategyConditionItem } from '@/api/modules/strategy/strategyConditions'
import type { QuadrantEntry } from '@/api/modules/strategy/regimeEngine'

const EXIT_MODE_OPTIONS: SelectOption[] = [
  { label: 'trailing_lock（尾部锁定）', value: 'trailing_lock' },
  { label: 'fixed_n（固定天数）', value: 'fixed_n' },
  { label: 'strategy（策略出场）', value: 'strategy' },
]

const props = defineProps<{
  quadrant: QuadrantEntry
}>()

function setExitMode(mode: string | null) {
  const q = props.quadrant
  q.exitMode = mode as QuadrantEntry['exitMode']
  if (!mode) {
    q.exitParams = null
    return
  }
  if (mode === 'trailing_lock') {
    q.exitParams = asExitParamsRecord(hydrateTrailingLockParams(null))
  } else if (mode === 'fixed_n') {
    q.exitParams = { N: null }
  } else if (mode === 'strategy') {
    q.exitParams = { exitConditions: [], maxHold: null }
  }
}

function setExitParam(param: string, value: unknown) {
  const q = props.quadrant
  if (!q.exitParams) q.exitParams = {}
  q.exitParams[param] = value
}
</script>
