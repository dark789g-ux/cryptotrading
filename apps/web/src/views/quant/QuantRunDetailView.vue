<template>
  <div class="page">
    <div class="page-header">
      <div class="back">
        <n-button text size="small" @click="goBack">← 返回 Run 列表</n-button>
      </div>
    </div>

    <n-alert v-if="errorText" type="error" :title="errorText" closable
      style="margin-bottom: 12px;" />

    <n-spin v-if="loading" />

    <template v-else-if="run">
      <RunDetailHeader :run="run">
        <template #actions>
          <DownloadActions
            :run-id="run.id"
            :has-artifact="!!run.artifact_uri"
            :has-report="!!run.report_uri"
            :has-shap="!!run.shap_uri"
          />
        </template>
      </RunDetailHeader>

      <n-grid x-gap="12" y-gap="12" cols="1 m:6" responsive="screen">
        <n-gi span="1 m:6">
          <ClassMetricsPanel
            v-if="isClassification"
            :metrics="run.oos_metrics ?? {}"
          />
          <OverallMetricsPanel
            v-else
            :core="run.oos_metrics_core"
            :metrics="run.oos_metrics ?? {}"
          />
        </n-gi>

        <n-gi span="1 m:3">
          <HyperparamsPanel :hyperparams="run.hyperparams ?? {}" />
        </n-gi>
        <n-gi span="1 m:3">
          <n-card title="SHAP Top-20 特征重要度" size="small" :bordered="false">
            <template #header-extra>
              <span class="meta">{{ shapMeta }}</span>
            </template>
            <ShapBarChart
              :items="shapItems"
              :loading="shapLoading"
              :error="shapError"
              :top-k="20"
            />
          </n-card>
        </n-gi>

        <n-gi span="1 m:6">
          <FoldMetricsTable :metrics="run.oos_metrics ?? {}" />
        </n-gi>
      </n-grid>
    </template>

    <n-empty v-else description="未找到该 run" />
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert, NButton, NCard, NEmpty, NGi, NGrid, NSpin,
} from 'naive-ui'
import RunDetailHeader from '@/components/quant/run-detail/RunDetailHeader.vue'
import HyperparamsPanel from '@/components/quant/run-detail/HyperparamsPanel.vue'
import OverallMetricsPanel from '@/components/quant/run-detail/OverallMetricsPanel.vue'
import ClassMetricsPanel from '@/components/quant/run-detail/ClassMetricsPanel.vue'
import FoldMetricsTable from '@/components/quant/run-detail/FoldMetricsTable.vue'
import DownloadActions from '@/components/quant/run-detail/DownloadActions.vue'
import ShapBarChart from '@/components/quant/ShapBarChart.vue'
import { quantApi, type ModelRunDetail, type ShapItem } from '@/api/modules/quant'

const route = useRoute()
const router = useRouter()

const run = ref<ModelRunDetail | null>(null)
const loading = ref(false)
const errorText = ref('')

const shapItems = ref<ShapItem[]>([])
const shapLoading = ref(false)
const shapError = ref<string | null>(null)

const currentId = computed(() => String(route.params.id ?? ''))

/** 按 oos_metrics.task 分支：分类 Run 用 ClassMetricsPanel 替代排序 OverallMetricsPanel */
const isClassification = computed(
  () => run.value?.oos_metrics?.task === 'classification_3class',
)

const shapMeta = computed(() => {
  if (shapLoading.value) return '加载中…'
  if (shapError.value) return ''
  if (shapItems.value.length === 0) return '无数据'
  return `共 ${shapItems.value.length} 项`
})

async function loadRun() {
  const id = currentId.value
  if (!id) return
  loading.value = true
  errorText.value = ''
  try {
    run.value = await quantApi.getRun(id)
  } catch (e) {
    errorText.value = `加载 Run 失败：${(e as Error).message}`
    run.value = null
  } finally {
    loading.value = false
  }
}

async function loadShap() {
  const id = currentId.value
  if (!id || !run.value) return
  if (!run.value.shap_uri) {
    shapItems.value = []
    shapError.value = null
    return
  }
  shapLoading.value = true
  shapError.value = null
  try {
    const res = await quantApi.getRunShap(id)
    shapItems.value = res.items ?? []
  } catch (e) {
    shapError.value = `加载 SHAP 失败：${(e as Error).message}`
    shapItems.value = []
  } finally {
    shapLoading.value = false
  }
}

async function refresh() {
  await loadRun()
  await loadShap()
}

function goBack() {
  if (window.history.length > 1) {
    router.back()
  } else {
    router.push({ name: 'quant-runs' })
  }
}

onMounted(refresh)
onActivated(refresh) // CLAUDE.md keep-alive 规范
watch(currentId, refresh)
</script>

<style scoped>
.page {
  padding: 16px 24px;
}
.page-header {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  margin-bottom: 12px;
}
.meta {
  color: var(--color-text-muted);
  font-size: 12px;
}
</style>
