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

    <!-- 信号源：三态选择器（选方案+历史 run / 手填 uuid / 新建信号源） -->
    <div class="src-row__field">
      <div class="src-row__field-label">信号源</div>
      <PortfolioSimSourceRunPicker
        :run-id="model.runId"
        :schemes="schemes"
        :disabled="disabled"
        @update="patch"
      />
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

    <!-- 排序 rankSpec（多因子；legacy rankField 在适配器侧自动兼容）-->
    <div class="src-row__field">
      <div class="src-row__field-label">排序规则</div>
      <RankSpecEditor
        :factors="rankFactors"
        :disabled="disabled"
        @update:factors="onFactorsChange"
      />
    </div>

    <!-- 仓位 sizing -->
    <div class="src-row__field">
      <div class="src-row__field-label">仓位模式</div>
      <SizingFields
        :model="sizingModel"
        :disabled="disabled"
        @update="onSizingPatch"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, NInputNumber, NSelect, NSlider, NSpace } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import type {
  PortfolioSimSource,
  RankFactor,
  SizingConfig,
} from '../../api/modules/strategy/portfolioSim'
import type { SignalTestWithLatestRun } from '../../api/modules/strategy/signalStats'
import RankSpecEditor from './RankSpecEditor.vue'
import SizingFields from './SizingFields.vue'
import PortfolioSimSourceRunPicker from './PortfolioSimSourceRunPicker.vue'
import {
  QUADRANT_PRESETS,
  QUADRANT_PRESET_LABELS,
  DEFAULT_SIZING,
  type QuadrantPreset,
} from './portfolioSimPresets'

/**
 * 把 source 的排序配置解析为因子数组（前端镜像后端 resolveRankSpec）：
 *   rankSpec.factors 非空 → 直接用；rankField==='none' → []；否则 legacy 单因子。
 */
function resolveFactors(src: PortfolioSimSource): RankFactor[] {
  if (src.rankSpec?.factors?.length) return src.rankSpec.factors
  if (src.rankField === 'none') return []
  return [{ factor: src.rankField, weight: 1, dir: src.rankDir }]
}

const props = defineProps<{
  index: number
  model: PortfolioSimSource
  schemes: SignalTestWithLatestRun[]
  removable: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<PortfolioSimSource>): void
  (e: 'remove'): void
}>()

const quadrantPreset = ref<QuadrantPreset>('none')

/** 当前排序因子数组（rankSpec 优先，legacy 兼容）。 */
const rankFactors = computed<RankFactor[]>(() => resolveFactors(props.model))

/** sizing 模型（缺省回落 DEFAULT_SIZING，使子组件总有完整对象可编辑）。 */
const sizingModel = computed<SizingConfig>(() => props.model.sizing ?? DEFAULT_SIZING)

const quadrantOptions = computed<SelectOption[]>(() =>
  (Object.keys(QUADRANT_PRESET_LABELS) as QuadrantPreset[]).map((k) => ({
    label: QUADRANT_PRESET_LABELS[k],
    value: k,
  })),
)

function patch(p: Partial<PortfolioSimSource>) {
  emit('update', p)
}

function onQuadrantChange(v: QuadrantPreset) {
  quadrantPreset.value = v
  if (v === 'none') return
  const preset = QUADRANT_PRESETS[v]
  // 预设的 legacy 单字段同时翻译成 rankSpec（统一走多因子契约）。
  const rf = preset.rankField
  patch({
    label: preset.label,
    exposureCap: preset.exposureCap,
    rankField: rf,
    rankDir: preset.rankDir,
    rankSpec: {
      factors: rf === 'none' ? [] : [{ factor: rf, weight: 1, dir: preset.rankDir }],
    },
  })
}

function onExposureSlider(v: number) {
  // slider 拖到 0 视为「不限」（null）
  patch({ exposureCap: v <= 0 ? null : v })
}

/**
 * 排序因子变更：统一写入 rankSpec（引擎优先消费）。
 * 同步把 legacy rankField/rankDir 收敛到合法兜底：
 *   []      → rankField 'none'
 *   单因子且为 legacy 可表达 key（pos_120/circ_mv）→ 同步；否则 rankField 'none'（rankSpec 接管）。
 */
function onFactorsChange(factors: RankFactor[]) {
  const p: Partial<PortfolioSimSource> = { rankSpec: { factors } }
  if (factors.length === 0) {
    p.rankField = 'none'
  } else if (
    factors.length === 1 &&
    (factors[0].factor === 'pos_120' || factors[0].factor === 'circ_mv')
  ) {
    p.rankField = factors[0].factor
    p.rankDir = factors[0].dir
  } else {
    p.rankField = 'none'
  }
  patch(p)
}

function onSizingPatch(patchSizing: Partial<SizingConfig>) {
  const base = props.model.sizing ?? DEFAULT_SIZING
  patch({ sizing: { ...base, ...patchSizing } })
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

.src-row__val {
  color: var(--color-primary, #2080f0);
  font-variant-numeric: tabular-nums;
}

.src-row__inline {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
