<template>
  <n-form label-placement="left" label-width="80">
    <n-form-item label="标签">
      <n-input
        :value="quadrant.label"
        placeholder="象限显示标签"
        style="max-width: 200px"
        @update:value="(v: string) => (quadrant.label = v)"
      />
    </n-form-item>
    <n-form-item label="动作">
      <n-select
        :value="quadrant.action"
        :options="ACTION_OPTIONS"
        style="width: 160px"
        @update:value="(v: 'trade' | 'flat') => setAction(v)"
      />
    </n-form-item>

    <template v-if="quadrant.action === 'trade'">
      <n-form-item label="仓位比例" required>
        <n-input-number
          :value="quadrant.positionRatio ?? null"
          :min="0.01"
          :max="1"
          :step="0.01"
          placeholder="0~1"
          style="width: 160px"
          @update:value="(v: number | null) => (quadrant.positionRatio = v)"
        />
      </n-form-item>
      <n-form-item label="最大持仓" required>
        <n-input-number
          :value="quadrant.maxPositions ?? null"
          :min="1"
          placeholder="正整数"
          style="width: 160px"
          @update:value="(v: number | null) => (quadrant.maxPositions = v)"
        />
      </n-form-item>
      <n-form-item label="选股排序" required>
        <n-space>
          <n-select
            :value="quadrant.rankField ?? 'turnover_rate'"
            :options="rankFieldSelectOptions"
            style="width: 180px"
            @update:value="(v: string) => onRankFieldChange(v)"
          />
          <n-select
            v-if="quadrant.rankField !== 'none'"
            :value="quadrant.rankDir ?? 'desc'"
            :options="RANK_DIR_OPTIONS"
            style="width: 100px"
            @update:value="(v: 'asc' | 'desc') => (quadrant.rankDir = v)"
          />
        </n-space>
      </n-form-item>
      <n-form-item>
        <template #label>
          <LabelWithTip label="仅全部盈利时开新仓">
            开启后，仅当全部现存持仓市值不低于成本时才允许新开仓
          </LabelWithTip>
        </template>
        <n-switch
          :value="quadrant.requireAllPositionsProfitable === true"
          @update:value="(v: boolean) => (quadrant.requireAllPositionsProfitable = v)"
        />
      </n-form-item>
    </template>

    <n-divider>分桶条件（大盘级）</n-divider>
    <regime-bucket-condition-rows
      :conditions="quadrant.match"
      @update:conditions="(v: RegimeBucketCondition[]) => (quadrant.match = v)"
    />
    <n-text
      v-if="isSingleQuadrant"
      depth="3"
      style="font-size: 12px; display: block; margin-top: 4px"
    >
      单象限无需设置分桶条件，任何市场环境都将命中此象限
    </n-text>
  </n-form>
</template>

<script setup lang="ts">
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NDivider,
  NSpace,
  NSwitch,
  NText,
} from 'naive-ui'
import LabelWithTip from '@/components/backtest/strategy/LabelWithTip.vue'
import type { SelectOption } from 'naive-ui'
import RegimeBucketConditionRows from '@/components/regime/RegimeBucketConditionRows.vue'
import {
  RANK_FIELD_OPTIONS,
  RANK_DIR_OPTIONS,
  defaultDirForRankField,
} from '@/components/regime/rankFieldMeta'
import type {
  QuadrantEntry,
  RegimeBucketCondition,
} from '@/api/modules/strategy/regimeEngine'

const ACTION_OPTIONS: SelectOption[] = [
  { label: 'trade（交易）', value: 'trade' },
  { label: 'flat（空仓）', value: 'flat' },
]

const rankFieldSelectOptions: SelectOption[] = RANK_FIELD_OPTIONS.map((o) => ({
  label: o.label,
  value: o.value,
}))

const props = defineProps<{
  quadrant: QuadrantEntry
  isSingleQuadrant: boolean
}>()

function setAction(action: 'trade' | 'flat') {
  const q = props.quadrant
  q.action = action
  if (action === 'flat') {
    q.entryConditions = []
    q.exitMode = null
    q.exitParams = null
  } else {
    if (q.positionRatio == null) q.positionRatio = 0.2
    if (q.maxPositions == null) q.maxPositions = 4
    if (q.rankField == null || q.rankField === '') {
      q.rankField = 'turnover_rate'
      q.rankDir = 'desc'
    } else if (q.rankField !== 'none' && q.rankDir == null) {
      q.rankDir = defaultDirForRankField(q.rankField) ?? 'desc'
    }
  }
}

function onRankFieldChange(field: string) {
  const q = props.quadrant
  q.rankField = field
  if (field === 'none') {
    q.rankDir = null
  } else {
    q.rankDir = defaultDirForRankField(field) ?? 'desc'
  }
}
</script>
