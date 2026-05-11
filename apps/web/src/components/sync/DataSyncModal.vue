<template>
  <AppModal
    :show="show"
    :title="title"
    :description="description"
    :header-icon="icon"
    width="min(92vw, 520px)"
    :mask-closable="!syncing || !!finished"
    :closable="!syncing || !!finished"
    @update:show="emit('update:show', $event)"
  >
    <div class="dsm-form">
      <!-- 当前库存范围 -->
      <div class="dsm-field-block">
        <div class="dsm-field-label">
          <n-icon><calendar-outline /></n-icon>
          <span>当前库存范围</span>
        </div>
        <div class="dsm-range-value">
          <span>{{ dataDateRangeLabel }}</span>
          <n-spin v-if="dataDateRangeLoading" :size="14" />
        </div>
      </div>

      <!-- 同步模式 -->
      <div class="dsm-field-block">
        <div class="dsm-field-label">
          <n-icon><swap-horizontal-outline /></n-icon>
          <span>同步模式</span>
        </div>
        <n-radio-group
          :value="syncMode"
          size="small"
          :disabled="syncing"
          @update:value="handleSyncModeChange"
        >
          <n-radio-button value="incremental">增量同步</n-radio-button>
          <n-radio-button value="overwrite">覆盖同步</n-radio-button>
        </n-radio-group>
        <div class="dsm-mode-note">{{ syncModeNote }}</div>
      </div>

      <!-- 同步日期范围 -->
      <div class="dsm-field-block dsm-field-block--range">
        <div class="dsm-field-label">
          <n-icon><calendar-outline /></n-icon>
          <span>同步日期范围</span>
        </div>
        <n-date-picker
          :value="syncDateRange"
          type="daterange"
          clearable
          :disabled="syncing"
          class="dsm-date-picker"
          @update:value="emit('update:syncDateRange', $event)"
        />
        <div class="dsm-range-preview">
          <span>{{ rangeLabel.start }}</span>
          <n-icon><swap-horizontal-outline /></n-icon>
          <span>{{ rangeLabel.end }}</span>
        </div>
      </div>

      <!-- 额外内容（进度条等）由父组件通过 slot 注入 -->
      <slot name="extra" />
    </div>

    <template #actions>
      <template v-if="!finished">
        <n-button :disabled="syncing" @click="emit('update:show', false)">取消</n-button>
        <n-button
          type="primary"
          :loading="syncing"
          :disabled="!canConfirm"
          @click="emit('confirm')"
        >
          确认同步
        </n-button>
      </template>
      <n-button v-else type="primary" @click="emit('update:show', false)">关闭</n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { NButton, NDatePicker, NIcon, NRadioButton, NRadioGroup, NSpin } from 'naive-ui'
import { CalendarOutline, SwapHorizontalOutline } from '@vicons/ionicons5'
import AppModal from '../common/AppModal.vue'

type SyncMode = 'incremental' | 'overwrite'

const props = defineProps<{
  show: boolean
  title: string
  description: string
  icon: Component
  syncing: boolean
  syncMode: SyncMode
  syncDateRange: [number, number] | null
  dataDateRangeLabel: string
  dataDateRangeLoading: boolean
  canConfirm: boolean
  finished?: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'update:syncMode': [value: SyncMode]
  'update:syncDateRange': [value: [number, number] | null]
  confirm: []
}>()

function handleSyncModeChange(value: string | number | boolean) {
  if (value === 'incremental' || value === 'overwrite') emit('update:syncMode', value)
}

const syncModeNote = computed(() =>
  props.syncMode === 'overwrite'
    ? '重新拉取并覆盖写入所选日期范围内的全部数据。'
    : '仅补齐缺失日期，已有数据自动跳过。',
)

const rangeLabel = computed(() => {
  const r = props.syncDateRange
  if (!r) return { start: '未选择', end: '未选择' }
  // 与各 sync composables 的 toYYYYMMDD 保持本地 TZ 一致，否则 CST 用户选的日期会被推前 1 天
  const fmt = (ts: number) => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return { start: fmt(r[0]), end: fmt(r[1]) }
})
</script>

<style scoped>
.dsm-header { display: flex; align-items: center; gap: 12px; }
.dsm-icon {
  width: 38px; height: 38px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid color-mix(in srgb, var(--color-primary) 40%, var(--color-border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-primary) 14%, var(--color-surface-elevated));
  color: var(--color-primary); font-size: 20px;
}
.dsm-title { margin: 0; font-size: 18px; line-height: 1.2; }
.dsm-desc { margin: 5px 0 0; color: var(--color-text-secondary); font-size: 13px; }
.dsm-form { display: flex; flex-direction: column; gap: 14px; }
.dsm-field-block {
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}
.dsm-field-block--range {
  background: color-mix(in srgb, var(--color-surface-elevated) 60%, var(--color-surface));
}
.dsm-field-label {
  display: flex; align-items: center; gap: 7px;
  margin-bottom: 10px;
  color: var(--color-text); font-size: 13px; font-weight: 700;
}
.dsm-range-value {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  color: var(--color-text); font-size: 14px; font-weight: 700;
}
.dsm-mode-note { margin-top: 10px; color: var(--color-text-secondary); font-size: 13px; line-height: 1.45; }
.dsm-date-picker { width: 100%; }
.dsm-range-preview {
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  gap: 10px; margin-top: 12px;
  color: var(--color-text-secondary); font-size: 13px; text-align: center;
}
.dsm-range-preview span {
  min-width: 0; padding: 8px 10px;
  border-radius: 7px; background: var(--color-surface); color: var(--color-text);
}
.dsm-actions { display: flex; justify-content: flex-end; gap: 10px; }
</style>
