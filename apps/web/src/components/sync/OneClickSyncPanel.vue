<template>
  <div class="one-click-sync">
    <!-- 头部：日期选择 + 控制 -->
    <div class="ocs-header">
      <div class="ocs-header-left">
        <span class="ocs-header-icon" aria-hidden="true">🚀</span>
        <div class="ocs-header-text">
          <div class="ocs-title">{{ title }}</div>
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
    <ul class="ocs-steps">
      <li
        v-for="(step, idx) in ctrl.steps.value"
        :key="step.step"
        class="ocs-step-row"
        :class="`ocs-step-row--${step.status}`"
      >
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
import { NButton, NCheckbox, NDatePicker, NProgress, NSpin, useMessage } from 'naive-ui'
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

<style scoped>
.one-click-sync {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ocs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.ocs-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ocs-header-icon {
  font-size: 28px;
}
.ocs-title {
  font-size: 16px;
  font-weight: 600;
}
.ocs-subtitle {
  font-size: 12px;
  opacity: 0.7;
}
.ocs-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ocs-date-picker {
  min-width: 260px;
}

.ocs-total-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ocs-total-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  opacity: 0.8;
}

.ocs-steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.ocs-step-row {
  display: flex;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-surface-elevated, #f5f5f5) 60%, transparent);
  transition: background 0.2s;
}
.ocs-step-row--running {
  background: color-mix(in srgb, var(--color-primary, #2080f0) 12%, transparent);
}
.ocs-step-row--failed {
  background: color-mix(in srgb, #d03050 12%, transparent);
}
.ocs-step-row--success {
  background: color-mix(in srgb, #18a058 10%, transparent);
}
.ocs-step-icon {
  width: 24px;
  text-align: center;
  font-size: 16px;
  align-self: flex-start;
  padding-top: 2px;
}
.ocs-step-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.ocs-step-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
}
.ocs-step-label {
  font-weight: 500;
}
.ocs-step-meta {
  font-size: 12px;
  opacity: 0.8;
}
.ocs-step-progress {
  margin: 2px 0;
}
.ocs-step-message {
  font-size: 12px;
  opacity: 0.75;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ocs-step-phase {
  margin-right: 6px;
  opacity: 0.6;
}

.ocs-log-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ocs-log-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  opacity: 0.85;
}
.ocs-log-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ocs-log-box {
  height: 200px;
  overflow-y: auto;
  background: var(--color-surface, #1e1e1e);
  border-radius: 4px;
  padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  border: 1px solid color-mix(in srgb, var(--color-border, #ccc) 50%, transparent);
}
.ocs-log-line {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  line-height: 1.5;
}
.ocs-log-line--warn {
  color: #f0a020;
}
.ocs-log-line--error {
  color: #d03050;
}
.ocs-log-ts {
  opacity: 0.55;
  flex-shrink: 0;
}
.ocs-log-step {
  opacity: 0.7;
  flex-shrink: 0;
}
.ocs-log-text {
  word-break: break-all;
}
.ocs-log-empty {
  opacity: 0.5;
  text-align: center;
  padding: 16px 0;
}

.ocs-summary {
  border-radius: 6px;
  padding: 12px;
  background: color-mix(in srgb, var(--color-surface-elevated, #f5f5f5) 60%, transparent);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ocs-summary-title {
  font-size: 14px;
  font-weight: 600;
}
.ocs-summary-steps {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.ocs-summary-meta {
  margin-left: 8px;
  opacity: 0.8;
  font-size: 12px;
}
.ocs-summary-footer {
  display: flex;
  gap: 16px;
  align-items: center;
  font-size: 12px;
  opacity: 0.85;
  flex-wrap: wrap;
}
.ocs-summary-errors {
  margin-top: 4px;
  font-size: 12px;
}
.ocs-summary-errors ul {
  margin: 6px 0 0;
  padding-left: 18px;
  max-height: 200px;
  overflow-y: auto;
}
.ocs-summary-error--warn {
  color: #f0a020;
}
.ocs-summary-error--error {
  color: #d03050;
}

@media (max-width: 960px) {
  .ocs-header {
    flex-direction: column;
    align-items: stretch;
  }
  .ocs-header-right {
    flex-direction: column;
    align-items: stretch;
  }
  .ocs-date-picker {
    min-width: 100%;
  }
}
</style>
