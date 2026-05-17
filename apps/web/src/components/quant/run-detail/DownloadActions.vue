<template>
  <n-button-group size="small">
    <n-button
      :disabled="!modelUrl"
      tag="a"
      :href="modelUrl || '#'"
      :download="modelName"
      target="_blank"
    >
      下载 model.txt
    </n-button>
    <n-button
      :disabled="!reportUrl"
      tag="a"
      :href="reportUrl || '#'"
      :download="reportName"
      target="_blank"
    >
      下载 report.md
    </n-button>
    <n-button
      :disabled="!shapUrl"
      tag="a"
      :href="shapUrl || '#'"
      :download="shapName"
      target="_blank"
    >
      下载 shap.json
    </n-button>
  </n-button-group>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NButtonGroup } from 'naive-ui'

/**
 * 下载按钮组
 *
 * 三个产物默认走 NestJS 静态文件代理：`GET /api/quant/runs/:id/artifact?file=...`
 * 由 Part B agent 提供。若 run.artifact_uri 已是绝对 URL（如对象存储），
 * 也可直接当 href 用；这里通过 `runId` + `kind` 走代理更通用。
 */
const props = defineProps<{
  runId: string
  hasArtifact: boolean
  hasReport: boolean
  hasShap: boolean
}>()

function buildArtifactUrl(kind: 'model' | 'report' | 'shap'): string {
  const fileMap = { model: 'model.txt', report: 'report.md', shap: 'shap.json' } as const
  const qs = new URLSearchParams({ file: fileMap[kind] })
  return `/api/quant/runs/${encodeURIComponent(props.runId)}/artifact?${qs.toString()}`
}

const modelUrl = computed(() => (props.hasArtifact ? buildArtifactUrl('model') : ''))
const reportUrl = computed(() => (props.hasReport ? buildArtifactUrl('report') : ''))
const shapUrl = computed(() => (props.hasShap ? buildArtifactUrl('shap') : ''))

const modelName = computed(() => `${props.runId}-model.txt`)
const reportName = computed(() => `${props.runId}-report.md`)
const shapName = computed(() => `${props.runId}-shap.json`)
</script>
