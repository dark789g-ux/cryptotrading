<template>
  <div class="src-row">
    <div class="src-row__head">
      <span class="src-row__idx">源 #{{ index + 1 }}</span>
      <n-space :size="8" align="center">
        <span class="src-row__quad-label">象限预设</span>
        <n-select
          :value="quadrantPreset"
          :options="quadrantOptions"
          size="small"
          style="width: 200px"
          :disabled="disabled"
          @update:value="onQuadrantChange"
        />
        <n-button
          size="tiny"
          quaternary
          type="error"
          :disabled="disabled || !removable"
          @click="emit('remove')"
        >
          移除
        </n-button>
      </n-space>
    </div>

    <!-- 方案选择 / 高级手填 runId -->
    <div class="src-row__field">
      <div class="src-row__field-label">
        信号源
        <n-switch v-model:value="advanced" size="small" :disabled="disabled" />
        <span class="src-row__hint">{{ advanced ? '高级：手填 run id' : '选方案（用其最新 completed run）' }}</span>
      </div>
      <template v-if="!advanced">
        <n-select
          :value="schemeId"
          :options="schemeOptions"
          placeholder="选择一个已完成的信号方案"
          size="small"
          filterable
          :disabled="disabled"
          @update:value="onSchemeChange"
        />
        <div v-if="schemeId && !resolvedRunId" class="src-row__warn">
          该方案最新 run 非 completed，无法纳入；请改用高级模式手填某个 completed run id。
        </div>
      </template>
      <template v-else>
        <n-input
          :value="model.runId"
          placeholder="粘贴 signal_test_run 的 uuid"
          size="small"
          :disabled="disabled"
          @update:value="(v: string) => patch({ runId: v.trim() })"
        />
      </template>
    </div>

    <!-- label -->
    <div class="src-row__field">
      <div class="src-row__field-label">标签（组内唯一）</div>
      <n-input
        :value="model.label"
        placeholder="如 Q3主选"
        size="small"
        :disabled="disabled"
        @update:value="(v: string) => patch({ label: v })"
      />
    </div>

    <!-- positionRatio -->
    <div class="src-row__field">
      <div class="src-row__field-label">
        单票权重 positionRatio
        <span class="src-row__val">{{ (model.positionRatio * 100).toFixed(2) }}%</span>
      </div>
      <div class="src-row__inline">
        <n-slider
          :value="model.positionRatio"
          :min="0.001"
          :max="1"
          :step="0.001"
          :disabled="disabled"
          style="flex: 1"
          @update:value="(v: number) => patch({ positionRatio: v })"
        />
        <n-input-number
          :value="model.positionRatio"
          :min="0.001"
          :max="1"
          :step="0.001"
          size="small"
          :disabled="disabled"
          style="width: 120px"
          @update:value="(v: number | null) => patch({ positionRatio: v ?? 0.001 })"
        />
      </div>
    </div>

    <!-- maxPositions（可空=不限）-->
    <div class="src-row__field">
      <div class="src-row__field-label">最大持仓 maxPositions（空 = 不限）</div>
      <n-input-number
        :value="model.maxPositions"
        :min="1"
        clearable
        placeholder="不限"
        size="small"
        :disabled="disabled"
        style="width: 100%"
        @update:value="(v: number | null) => patch({ maxPositions: v })"
      />
    </div>

    <!-- exposureCap（可空=不限）-->
    <div class="src-row__field">
      <div class="src-row__field-label">
        总敞口上限 exposureCap（空 = 不限）
        <span v-if="model.exposureCap != null" class="src-row__val">{{ (model.exposureCap * 100).toFixed(1) }}%</span>
      </div>
      <div class="src-row__inline">
        <n-slider
          :value="model.exposureCap ?? 0"
          :min="0"
          :max="1"
          :step="0.01"
          :disabled="disabled"
          style="flex: 1"
          @update:value="onExposureSlider"
        />
        <n-input-number
          :value="model.exposureCap"
          :min="0.01"
          :max="1"
          :step="0.01"
          clearable
          placeholder="不限"
          size="small"
          :disabled="disabled"
          style="width: 120px"
          @update:value="(v: number | null) => patch({ exposureCap: v })"
        />
      </div>
    </div>

    <!-- rankField -->
    <div class="src-row__field">
      <div class="src-row__field-label">排序字段 rankField</div>
      <n-select
        :value="model.rankField"
        :options="rankFieldOptions"
        size="small"
        :disabled="disabled"
        @update:value="(v: PortfolioRankField) => patch({ rankField: v })"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, NInputNumber, NSelect, NSlider, NSpace, NSwitch } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import type {
  PortfolioSimSource,
  PortfolioRankField,
} from '../../api/modules/strategy/portfolioSim'
import {
  RANK_FIELD_OPTIONS,
  QUADRANT_PRESETS,
  QUADRANT_PRESET_LABELS,
  type QuadrantPreset,
} from './portfolioSimPresets'

/** 可选方案（来自 signal-tests 列表，已过滤为含 completed run 者由父级控制 disabled 提示）。 */
export interface SchemeOption extends SelectOption {
  label: string
  value: string
  /** 该方案最新 completed run 的 id；null 表示最新 run 非 completed。 */
  completedRunId: string | null
}

const props = defineProps<{
  index: number
  model: PortfolioSimSource
  schemes: SchemeOption[]
  removable: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<PortfolioSimSource>): void
  (e: 'remove'): void
}>()

const advanced = ref(false)
const schemeId = ref<string | null>(null)
const quadrantPreset = ref<QuadrantPreset>('none')

const rankFieldOptions = RANK_FIELD_OPTIONS

const schemeOptions = computed<SelectOption[]>(() =>
  props.schemes.map((s) => ({
    label: s.completedRunId ? s.label : `${s.label}（无 completed run）`,
    value: s.value,
    disabled: !s.completedRunId,
  })),
)

const quadrantOptions = computed<SelectOption[]>(() =>
  (Object.keys(QUADRANT_PRESET_LABELS) as QuadrantPreset[]).map((k) => ({
    label: QUADRANT_PRESET_LABELS[k],
    value: k,
  })),
)

/** 当前选中方案解析出的 run id（completed 才有）。 */
const resolvedRunId = computed<string | null>(() => {
  if (!schemeId.value) return null
  return props.schemes.find((s) => s.value === schemeId.value)?.completedRunId ?? null
})

function patch(p: Partial<PortfolioSimSource>) {
  emit('update', p)
}

function onSchemeChange(v: string) {
  schemeId.value = v
  const runId = props.schemes.find((s) => s.value === v)?.completedRunId ?? ''
  patch({ runId })
}

function onQuadrantChange(v: QuadrantPreset) {
  quadrantPreset.value = v
  if (v === 'none') return
  const preset = QUADRANT_PRESETS[v]
  patch({
    label: preset.label,
    exposureCap: preset.exposureCap,
    rankField: preset.rankField,
    rankDir: preset.rankDir,
  })
}

function onExposureSlider(v: number) {
  // slider 拖到 0 视为「不限」（null）
  patch({ exposureCap: v <= 0 ? null : v })
}
</script>

<style scoped>
.src-row {
  border: 1px solid var(--color-border, #e0e0e6);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.src-row__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.src-row__idx {
  font-weight: 600;
  font-size: 13px;
}

.src-row__quad-label {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
}

.src-row__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.src-row__field-label {
  font-size: 12px;
  color: var(--color-text-secondary, #888);
  display: flex;
  align-items: center;
  gap: 8px;
}

.src-row__hint {
  font-size: 11px;
  color: var(--color-text-muted, #aaa);
}

.src-row__val {
  color: var(--color-primary, #2080f0);
  font-variant-numeric: tabular-nums;
}

.src-row__inline {
  display: flex;
  align-items: center;
  gap: 12px;
}

.src-row__warn {
  font-size: 11px;
  color: #d03050;
}
</style>
