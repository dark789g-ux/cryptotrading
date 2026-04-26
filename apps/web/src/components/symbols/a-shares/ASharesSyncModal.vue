<template>
  <n-modal
    :show="show"
    preset="card"
    class="sync-modal"
    :style="{ width: 'min(92vw, 520px)' }"
    :bordered="false"
    :mask-closable="!syncing"
    :closable="!syncing"
    @update:show="emit('update:show', $event)"
  >
    <template #header>
      <div class="sync-modal-header">
        <div class="sync-modal-icon">
          <n-icon><cloud-download-outline /></n-icon>
        </div>
        <div>
          <h3>同步 A 股数据</h3>
          <p>从 TuShare 拉取日线行情与每日指标</p>
        </div>
      </div>
    </template>
    <div class="sync-form">
      <div class="sync-range-panel">
        <div class="sync-field-label">
          <n-icon><calendar-outline /></n-icon>
          <span>同步日期范围</span>
        </div>
        <n-date-picker
          :value="syncDateRange"
          type="daterange"
          clearable
          :disabled="syncing"
          class="sync-date-picker"
          @update:value="emit('update:syncDateRange', $event)"
        />
        <div class="sync-range-preview">
          <span>{{ syncRangeLabel.start }}</span>
          <n-icon><swap-horizontal-outline /></n-icon>
          <span>{{ syncRangeLabel.end }}</span>
        </div>
      </div>
      <div class="sync-note">
        <n-icon><information-circle-outline /></n-icon>
        <span>重复同步同一日期范围会覆盖更新本地数据，不会产生重复记录。</span>
      </div>
      <div v-if="syncProgressVisible" class="sync-progress-panel">
        <div class="sync-progress-head">
          <span>{{ syncPhase || syncStatusLabel }}</span>
          <span>{{ Math.round(syncPercent) }}%</span>
        </div>
        <n-progress
          type="line"
          :percentage="Math.round(syncPercent)"
          :status="syncStatus === 'error' ? 'error' : syncStatus === 'done' ? 'success' : 'default'"
          indicator-placement="inside"
        />
        <div class="sync-progress-meta">
          <span>{{ syncProgressCountLabel }}</span>
          <span>{{ syncMessage }}</span>
        </div>
      </div>
    </div>
    <template #footer>
      <div class="modal-actions">
        <n-button :disabled="syncing" @click="emit('update:show', false)">取消</n-button>
        <n-button type="primary" :loading="syncing" :disabled="!canConfirmSync" @click="emit('confirm')">
          确认同步
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { NButton, NDatePicker, NIcon, NModal, NProgress } from 'naive-ui'
import {
  CalendarOutline,
  CloudDownloadOutline,
  InformationCircleOutline,
  SwapHorizontalOutline,
} from '@vicons/ionicons5'

defineProps<{
  show: boolean
  syncing: boolean
  syncDateRange: [number, number] | null
  syncRangeLabel: { start: string; end: string }
  syncProgressVisible: boolean
  syncStatusLabel: string
  syncProgressCountLabel: string
  canConfirmSync: boolean
  syncPhase: string
  syncPercent: number
  syncStatus: string
  syncMessage: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  'update:syncDateRange': [value: [number, number] | null]
  confirm: []
}>()
</script>

<style scoped>
.sync-modal-header { display: flex; align-items: center; gap: 12px; }
.sync-modal-icon { width: 38px; height: 38px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid color-mix(in srgb, var(--color-primary) 40%, var(--color-border)); border-radius: 8px; background: color-mix(in srgb, var(--color-primary) 14%, var(--color-surface-elevated)); color: var(--color-primary); font-size: 20px; }
.sync-modal-header h3 { margin: 0; font-size: 18px; line-height: 1.2; }
.sync-modal-header p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: 13px; }
.sync-form { display: flex; flex-direction: column; gap: 14px; }
.sync-range-panel { padding: 14px; border: 1px solid var(--color-border); border-radius: 8px; background: color-mix(in srgb, var(--color-surface-elevated) 60%, var(--color-surface)); }
.sync-field-label { display: flex; align-items: center; gap: 7px; margin-bottom: 10px; color: var(--color-text); font-size: 13px; font-weight: 700; }
.sync-date-picker { width: 100%; }
.sync-range-preview { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px; margin-top: 12px; color: var(--color-text-secondary); font-size: 13px; text-align: center; }
.sync-range-preview span { min-width: 0; padding: 8px 10px; border-radius: 7px; background: var(--color-surface); color: var(--color-text); }
.sync-note { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--color-primary) 30%, var(--color-border)); border-radius: 8px; background: color-mix(in srgb, var(--color-primary) 8%, var(--color-surface)); color: var(--color-text-secondary); line-height: 1.45; }
.sync-note .n-icon { margin-top: 2px; color: var(--color-primary); }
.sync-progress-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
.sync-progress-head,
.sync-progress-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--color-text-secondary); font-size: 12px; }
.sync-progress-head { color: var(--color-text); font-weight: 700; }
.sync-progress-meta span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
</style>
