<template>
  <div class="one-click-sync">
    <!-- 头部：日期选择 + 控制 -->
    <div class="ocs-header">
      <div class="ocs-header-left">
        <span class="ocs-header-icon" aria-hidden="true">🚀</span>
        <div class="ocs-header-text">
          <div class="ocs-title">
            {{ title }}
            <span v-if="ctrl.latestSyncText.value" class="ocs-title-badge">最近成功 {{ ctrl.latestSyncText.value }}</span>
          </div>
          <div class="ocs-subtitle">{{ subtitle }}</div>
        </div>
      </div>
      <div class="ocs-header-right">
        <n-date-picker
          v-model:value="ctrl.dateRange.value"
          type="daterange"
          clearable
          :disabled="ctrl.running.value"
          format="yyyy-MM-dd"
          class="ocs-date-picker"
        />
        <div class="ocs-mode-switch">
          <n-switch
            v-model:value="ctrl.syncMode.value"
            :checked-value="'overwrite'"
            :unchecked-value="'incremental'"
            :disabled="ctrl.running.value"
          />
          <span class="ocs-switch-label">覆盖模式（重拉已有日期）</span>
        </div>
        <n-button
          v-if="!ctrl.running.value"
          type="primary"
          :disabled="!ctrl.canStart.value"
          @click="ctrl.start()"
        >
          开始同步
        </n-button>
        <n-button v-else type="warning" @click="ctrl.cancel()">取消</n-button>
      </div>
    </div>

    <!-- 总进度 -->
    <div class="ocs-total-progress">
      <div class="ocs-total-meta">
        <span>总进度</span>
        <span>{{ ctrl.totalPercent.value }}%</span>
        <span>{{ completedCount }}/{{ ctrl.steps.value.length }} 步骤</span>
        <span>耗时 {{ formatElapsed(ctrl.elapsedMs.value) }}</span>
      </div>
      <n-progress
        type="line"
        :percentage="ctrl.totalPercent.value"
        :height="8"
        :show-indicator="false"
        :status="totalStatus"
      />
    </div>

    <!-- 步骤列表 -->
    <div class="ocs-steps-toolbar">
      <n-button
        size="tiny"
        quaternary
        :disabled="ctrl.running.value"
        @click="toggleAllSteps"
      >{{ allSelectedLabel }}</n-button>
      <span class="ocs-steps-hint">⚠️ 步骤间存在数据依赖，取消上游步骤可能影响下游结果</span>
    </div>
    <ul class="ocs-steps">
      <li
        v-for="(step, idx) in ctrl.steps.value"
        :key="step.step"
        class="ocs-step-row"
        :class="`ocs-step-row--${step.status}`"
      >
        <n-checkbox
          class="ocs-step-checkbox"
          :checked="ctrl.selectedStepKeys.value.includes(step.step)"
          :disabled="ctrl.running.value"
          @update:checked="ctrl.toggleStep(step.step)"
        />
        <div class="ocs-step-icon" :title="step.status">
          <n-spin v-if="step.status === 'running'" :size="14" />
          <span v-else>{{ statusIcon(step.status) }}</span>
        </div>
        <div class="ocs-step-body">
          <div class="ocs-step-head">
            <span class="ocs-step-label">{{ idx + 1 }}. {{ step.label }}</span>
            <span class="ocs-step-meta">
              <span v-if="step.status === 'success' && step.rowsWritten > 0">写入 {{ step.rowsWritten }} 行</span>
              <span v-else-if="step.status === 'failed'">{{ step.errors.length }} 项错误</span>
              <span v-else-if="step.status === 'running'">{{ step.percent }}%</span>
              <span v-else-if="step.status === 'pending'">—</span>
              <span v-else-if="step.status === 'skipped'">已跳过</span>
            </span>
          </div>
          <div class="ocs-step-progress">
            <n-progress
              type="line"
              :percentage="step.percent"
              :height="4"
              :show-indicator="false"
              :status="stepProgressStatus(step.status)"
            />
          </div>
          <div v-if="step.message" class="ocs-step-message">
            <span v-if="step.phase" class="ocs-step-phase">[{{ step.phase }}]</span>
            <span>{{ step.message }}</span>
          </div>
        </div>
      </li>
    </ul>

    <!-- 实时日志 -->
    <div class="ocs-log-section">
      <div class="ocs-log-head">
        <span>实时日志 ({{ ctrl.logEntries.value.length }})</span>
        <div class="ocs-log-actions">
          <n-checkbox v-model:checked="autoScroll" size="small">自动滚动</n-checkbox>
          <n-button size="tiny" quaternary @click="logExpanded = !logExpanded">
            {{ logExpanded ? '折叠' : '展开' }}
          </n-button>
        </div>
      </div>
      <div v-show="logExpanded" ref="logBox" class="ocs-log-box">
        <div
          v-for="(entry, idx) in ctrl.logEntries.value"
          :key="idx"
          class="ocs-log-line"
          :class="`ocs-log-line--${entry.level}`"
        >
          <span class="ocs-log-ts">{{ formatTs(entry.ts) }}</span>
          <span class="ocs-log-step">[{{ entry.step }}]</span>
          <span class="ocs-log-text">{{ entry.text }}</span>
        </div>
        <div v-if="ctrl.logEntries.value.length === 0" class="ocs-log-empty">暂无日志</div>
      </div>
    </div>

    <!-- 结束态 summary -->
    <div v-if="ctrl.summary.value && !ctrl.running.value" class="ocs-summary">
      <div class="ocs-summary-title">
        {{ ctrl.summary.value.cancelled ? '一键同步已取消' : '一键同步结束' }}
      </div>
      <ul class="ocs-summary-steps">
        <li v-for="s in ctrl.summary.value.steps" :key="s.step">
          {{ statusIcon(s.status) }} {{ s.label }}
          <span class="ocs-summary-meta">
            <span v-if="s.status === 'success'">成功 · 写入 {{ s.rowsWritten }} 行</span>
            <span v-else-if="s.status === 'failed'">失败 · {{ s.errors.length }} 项错误</span>
            <span v-else-if="s.status === 'skipped'">已跳过</span>
            <span v-else>未执行</span>
          </span>
        </li>
      </ul>
      <div class="ocs-summary-footer">
        <span>总耗时 {{ formatElapsed(ctrl.summary.value.totalMs) }}</span>
        <span>错误/警告共 {{ ctrl.summary.value.errors.length }} 项</span>
        <n-button
          v-if="hasFailedSteps"
          size="small"
          @click="retryFailed"
        >重试失败步骤</n-button>
      </div>
      <details v-if="ctrl.summary.value.errors.length > 0" class="ocs-summary-errors">
        <summary>查看错误详情 ({{ ctrl.summary.value.errors.length }})</summary>
        <ul>
          <li
            v-for="(e, idx) in ctrl.summary.value.errors"
            :key="idx"
            :class="`ocs-summary-error--${e.level}`"
          >
            [{{ e.step }}]<span v-if="e.apiName"> [{{ e.apiName }}]</span> {{ e.message }}
          </li>
        </ul>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NButton, NCheckbox, NDatePicker, NProgress, NSpin, NSwitch, useMessage } from 'naive-ui'
import { useOneClickSync, type OneClickStepStatus } from './useOneClickSync'
import type { OneClickPanelController } from './oneClickSync.types'

const props = withDefaults(
  defineProps<{
    controller?: OneClickPanelController
    title?: string
    subtitle?: string
  }>(),
  {
    controller: undefined,
    title: '一键同步 A 股核心数据',
    subtitle:
      '按顺序同步：基础数据 → A股数据 → 资金流向 → 指数日线 → 个股/行业/板块 AMV → 大盘 0AMV',
  },
)

const fallbackMessage = useMessage()
const ctrl = props.controller ?? useOneClickSync(fallbackMessage)

const logExpanded = ref(true)
const autoScroll = ref(true)
const logBox = ref<HTMLElement | null>(null)

const completedCount = computed(
  () =>
    ctrl.steps.value.filter(s => s.status === 'success' || s.status === 'failed' || s.status === 'skipped').length,
)

const totalStatus = computed<'success' | 'error' | 'default' | 'info'>(() => {
  if (!ctrl.summary.value) return ctrl.running.value ? 'info' : 'default'
  const hasFailed = ctrl.summary.value.steps.some(s => s.status === 'failed')
  return hasFailed ? 'error' : 'success'
})

const hasFailedSteps = computed(
  () => ctrl.summary.value?.steps.some(s => s.status === 'failed') ?? false,
)

// 「全选/全不选」基于 controller 暴露的全集（A 股 13 / 美股 3），与 currentRun 是否就绪无关。
const allSelected = computed(
  () =>
    ctrl.allStepKeys.value.length > 0 &&
    ctrl.selectedStepKeys.value.length === ctrl.allStepKeys.value.length,
)
const allSelectedLabel = computed(() => (allSelected.value ? '全不选' : '全选'))

function toggleAllSteps() {
  ctrl.selectedStepKeys.value = allSelected.value ? [] : [...ctrl.allStepKeys.value]
}

function statusIcon(status: OneClickStepStatus): string {
  switch (status) {
    case 'pending':
      return '⚪'
    case 'running':
      return '⏳'
    case 'success':
      return '✅'
    case 'failed':
      return '❌'
    case 'skipped':
      return '⊘'
    default:
      return '⚪'
  }
}

function stepProgressStatus(status: OneClickStepStatus): 'success' | 'error' | 'default' | 'info' {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'running') return 'info'
  return 'default'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${pad2(m)}:${pad2(s)}`
}

function retryFailed() {
  // 重试策略：清空 summary 并重新跑（spec 允许整体重跑失败步骤；为简化此处全部重跑）。
  ctrl.start()
}

// 日志自动滚动
watch(
  () => ctrl.logEntries.value.length,
  () => {
    if (!autoScroll.value) return
    void nextTick(() => {
      if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
    })
  },
)

defineExpose({ ctrl })
</script>

<style scoped src="./OneClickSyncPanel.styles.css"></style>
