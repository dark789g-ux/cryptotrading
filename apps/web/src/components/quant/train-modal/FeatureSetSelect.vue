<template>
  <div>
    <n-select
      :value="featureSetId"
      :options="options"
      :loading="loading"
      clearable
      filterable
      placeholder="选择已备料的 feature_set…"
      @update:value="onSelect"
    />
    <div v-if="summaryText" class="fs-summary">
      {{ summaryText }}
    </div>
    <div v-else-if="!loading && options.length === 0" class="fs-summary fs-summary--empty">
      暂无已备料的 feature_set，请先运行备料任务
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from 'vue'
import { NSelect, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { quantApi, type FeatureSet, type CoverageSegment } from '@/api/modules/quant'

interface FsOption extends SelectOption {
  label: string
  value: string
  /** 持有原始 FeatureSet 供摘要展示和 is-date-disabled 计算 */
  fs: FeatureSet
}

const props = defineProps<{
  featureSetId: string | null
}>()

const emit = defineEmits<{
  'update:featureSetId': [value: string | null]
  /** 选中或取消选中时透出整个 FeatureSet（含 coverage），null 表示取消 */
  'update:featureSet': [value: FeatureSet | null]
}>()

const message = useMessage()
const loading = ref(false)
const featureSets = ref<FeatureSet[]>([])

async function loadFeatureSets() {
  loading.value = true
  try {
    featureSets.value = await quantApi.listFeatureSets({ materialized: true })
  } catch {
    message.warning('获取 feature_set 列表失败，请检查后端连接')
  } finally {
    loading.value = false
  }
}

/** 把 coverage 段列表压成人类可读摘要 */
function summarizeCoverage(coverage: CoverageSegment[]): string {
  if (coverage.length === 0) return '无覆盖数据'
  const fmt = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (coverage.length === 1) {
    return `覆盖 ${fmt(coverage[0].start)} ~ ${fmt(coverage[0].end)}`
  }
  const overall = `${fmt(coverage[0].start)} ~ ${fmt(coverage[coverage.length - 1].end)}`
  return `覆盖 ${overall}（${coverage.length} 段）`
}

const options = computed<FsOption[]>(() =>
  featureSets.value.map((fs) => ({
    label: buildLabel(fs),
    value: fs.feature_set_id,
    fs,
  })),
)

function buildLabel(fs: FeatureSet): string {
  const ver = fs.label_version ? `·v${fs.label_version}` : ''
  const cov = summarizeCoverage(fs.coverage)
  return `${fs.label_name}${ver} · ${fs.factor_version} · ${cov}`
}

const selectedFs = computed<FeatureSet | null>(() => {
  if (!props.featureSetId) return null
  return featureSets.value.find(fs => fs.feature_set_id === props.featureSetId) ?? null
})

const summaryText = computed<string | null>(() => {
  const fs = selectedFs.value
  if (!fs) return null
  return `feature_set: ${fs.feature_set_id} · ${summarizeCoverage(fs.coverage)}`
})

function onSelect(value: string | null) {
  emit('update:featureSetId', value)
  if (value === null) {
    emit('update:featureSet', null)
    return
  }
  const fs = featureSets.value.find(f => f.feature_set_id === value) ?? null
  emit('update:featureSet', fs)
}

// keep-alive 规范：异步数据放 onActivated；onMounted 兜底首次
let activatedOnce = false
onMounted(() => {
  if (!activatedOnce) {
    void loadFeatureSets()
  }
})
onActivated(() => {
  activatedOnce = true
  void loadFeatureSets()
})
</script>

<style scoped>
.fs-summary {
  margin-top: 4px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--color-text-muted, #999);
  background: color-mix(in srgb, var(--color-border, #e0e0e0) 16%, transparent);
  border-radius: 4px;
  border-left: 2px solid color-mix(in srgb, var(--color-primary, #18a058) 40%, transparent);
}
.fs-summary--empty {
  color: var(--color-text-muted, #999);
  border-left-color: color-mix(in srgb, #999 40%, transparent);
}
</style>
