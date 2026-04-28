<template>
  <div class="sync-view workspace-page workspace-page--medium">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">数据同步</h1>
    </div>

    <div class="sync-grid">
      <!-- 同步配置 -->
      <n-card class="config-card" title="同步配置" :bordered="false">
        <n-form label-placement="top" class="sync-config-form">
          <div class="data-source-grid">
            <section class="data-source-card data-source-card--crypto">
              <div class="data-source-header">
                <div class="data-source-icon">
                  <n-icon><sync-outline /></n-icon>
                </div>
                <div class="data-source-heading">
                  <span class="data-source-eyebrow">Crypto Market</span>
                  <h3 class="data-source-title">加密货币数据</h3>
                  <p class="data-source-desc">同步交易标的的多周期行情，支持全部标的或自定义范围。</p>
                </div>
              </div>

              <div class="data-source-body">
                <n-form-item label="时间周期">
                  <n-checkbox-group v-model:value="syncConfig.intervals">
                    <n-space>
                      <n-checkbox value="1h" label="1小时" />
                      <n-checkbox value="4h" label="4小时" />
                      <n-checkbox value="1d" label="日线" />
                    </n-space>
                  </n-checkbox-group>
                </n-form-item>

                <n-form-item label="标的筛选">
                  <n-radio-group v-model:value="symbolMode" class="symbol-mode">
                    <n-radio-button value="all">全部标的</n-radio-button>
                    <n-radio-button value="custom">自定义</n-radio-button>
                  </n-radio-group>
                </n-form-item>

                <n-form-item v-if="symbolMode === 'custom'" label="选择标的">
                  <n-select
                    v-model:value="syncConfig.symbols"
                    multiple
                    filterable
                    placeholder="搜索并选择标的"
                    :options="symbolOptions"
                    :loading="loadingSymbols"
                    max-tag-count="responsive"
                    style="width: 100%"
                  />
                </n-form-item>
              </div>

              <n-space justify="end" class="form-actions data-source-actions">
                <n-button @click="saveConfig" :loading="saving">保存配置</n-button>
                <n-button
                  type="primary"
                  :loading="sse.status.value === 'running'"
                  :disabled="sse.status.value === 'running'"
                  @click="startSync"
                >
                  <template #icon><n-icon><sync-outline /></n-icon></template>
                  {{ sse.status.value === 'running' ? '同步中...' : '开始同步' }}
                </n-button>
              </n-space>
            </section>

            <section class="data-source-card data-source-card--ashares">
              <div class="data-source-header">
                <div class="data-source-icon">
                  <n-icon><cloud-download-outline /></n-icon>
                </div>
                <div class="data-source-heading">
                  <span class="data-source-eyebrow">A-Share Market</span>
                  <h3 class="data-source-title">A 股数据</h3>
                  <p class="data-source-desc">TuShare 日线数据独立同步，与加密货币数据源并列管理。</p>
                </div>
              </div>

              <div class="data-source-body">
                <div class="source-metric">
                  <span class="source-metric-label">数据范围</span>
                  <span class="source-metric-value">
                    {{ aSharesDataDateRangeLoading ? '读取中...' : aSharesDataDateRangeLabel }}
                  </span>
                </div>
                <div class="source-note">
                  打开同步面板后可选择全量或增量同步，并查看同步进度。
                </div>
              </div>

              <div class="data-source-actions data-source-actions--single">
                <n-button
                  block
                  secondary
                  type="primary"
                  :loading="aSharesSyncing"
                  @click="openASharesSyncModal"
                >
                  <template #icon><n-icon><cloud-download-outline /></n-icon></template>
                  配置并同步
                </n-button>
              </div>
            </section>
          </div>
        </n-form>
      </n-card>

      <!-- 同步状态 -->
      <n-card class="status-card" title="同步状态" :bordered="false">
        <div class="status-content">
          <div class="status-orb" :class="sse.status.value">
            <div v-if="sse.status.value === 'running'" class="status-orb-pulse" />
            <n-icon size="38">
              <checkmark-circle v-if="sse.status.value === 'done'" />
              <close-circle v-else-if="sse.status.value === 'error'" />
              <sync-outline v-else-if="sse.status.value === 'running'" class="spinning" />
              <time-outline v-else />
            </n-icon>
          </div>
          <div class="status-meta">
            <h3 class="status-title">{{ statusText }}</h3>
            <p v-if="sse.phase.value && sse.status.value === 'running'" class="status-phase">{{ sse.phase.value }}</p>
            <p v-if="sse.message.value" class="status-message">{{ sse.message.value }}</p>
          </div>
          <div v-if="sse.status.value !== 'idle'" class="sync-progress-wrap">
            <div class="progress-header">
              <span class="progress-label">{{ sse.status.value === 'done' ? '已完成' : sse.status.value === 'error' ? '同步失败' : '同步进度' }}</span>
              <span class="progress-pct">{{ sse.percent.value }}%</span>
            </div>
            <n-progress
              type="line"
              :percentage="sse.percent.value"
              :show-indicator="false"
              :status="sse.status.value === 'error' ? 'error' : sse.status.value === 'done' ? 'success' : 'default'"
              class="sync-progress"
            />
            <div v-if="sse.current.value > 0" class="progress-detail">
              {{ sse.current.value }} / {{ sse.total.value }} 个标的
            </div>
          </div>
        </div>
      </n-card>

      <!-- 数据概览 -->
      <n-card class="overview-card" title="数据概览" :bordered="false">
        <div class="overview-grid">
          <div class="overview-item overview-item--interval">
            <div class="overview-value">{{ overview.intervals.join(' · ') || '—' }}</div>
            <div class="overview-label">已选周期</div>
          </div>
          <div class="overview-item overview-item--count">
            <div class="overview-value">{{ overview.symbolCount || '—' }}</div>
            <div class="overview-label">标的数量</div>
          </div>
          <div class="overview-item overview-item--sync">
            <div class="overview-value overview-value--small">{{ overview.lastSync || '—' }}</div>
            <div class="overview-label">上次同步</div>
          </div>
        </div>
      </n-card>

      <!-- 同步日志 -->
      <n-card class="log-card" :bordered="false">
        <template #header>
          <div class="log-header">
            <div class="log-terminal-dots">
              <span class="dot dot-close" />
              <span class="dot dot-min" />
              <span class="dot dot-max" />
            </div>
            <span class="log-title">同步日志</span>
            <span v-if="logs.length" class="log-count">{{ logs.length }} 条</span>
          </div>
        </template>
        <div ref="logRef" class="log-container">
          <div v-if="!logs.length" class="log-empty">
            <n-icon size="18"><time-outline /></n-icon>
            <span>暂无日志</span>
          </div>
          <div v-for="(log, i) in logs" :key="i" class="log-item" :class="log.type">
            <span class="log-time">{{ log.time }}</span>
            <span class="log-bullet">›</span>
            <span class="log-text">{{ log.message }}</span>
          </div>
        </div>
      </n-card>
    </div>

    <a-shares-sync-modal
      v-model:show="showASharesSyncModal"
      v-model:sync-mode="aSharesSyncMode"
      v-model:sync-date-range="aSharesSyncDateRange"
      :syncing="aSharesSyncing"
      :sync-range-label="aSharesSyncRangeLabel"
      :sync-progress-visible="aSharesSyncProgressVisible"
      :sync-status-label="aSharesSyncStatusLabel"
      :sync-progress-count-label="aSharesSyncProgressCountLabel"
      :can-confirm-sync="aSharesCanConfirmSync"
      :sync-phase="aSharesSyncPhase"
      :sync-percent="aSharesSyncPercent"
      :sync-status="aSharesSyncStatus"
      :sync-message="aSharesSyncMessage"
      :data-date-range-label="aSharesDataDateRangeLabel"
      :data-date-range-loading="aSharesDataDateRangeLoading"
      @confirm="syncAShares"
    />
  </div>
</template>

<script setup lang="ts">
import {
  NButton,
  NCard,
  NCheckbox,
  NCheckboxGroup,
  NForm,
  NFormItem,
  NIcon,
  NProgress,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  useMessage,
} from 'naive-ui'
import { SyncOutline, CheckmarkCircle, CloseCircle, TimeOutline, CloudDownloadOutline } from '@vicons/ionicons5'
import { useSyncView } from '../../composables/hooks/useSyncView'
import ASharesSyncModal from '../../components/symbols/a-shares/ASharesSyncModal.vue'
import { useASharesSync } from '../../components/symbols/a-shares/useASharesSync'

const message = useMessage()
const noopReload = async () => {}

const {
  sse,
  syncConfig,
  symbolMode,
  symbolOptions,
  loadingSymbols,
  saving,
  logs,
  logRef,
  overview,
  statusText,
  saveConfig,
  startSync,
} = useSyncView()

const {
  syncing: aSharesSyncing,
  showSyncModal: showASharesSyncModal,
  syncMode: aSharesSyncMode,
  syncDateRange: aSharesSyncDateRange,
  syncProgressVisible: aSharesSyncProgressVisible,
  syncStatusLabel: aSharesSyncStatusLabel,
  syncProgressCountLabel: aSharesSyncProgressCountLabel,
  canConfirmSync: aSharesCanConfirmSync,
  syncRangeLabel: aSharesSyncRangeLabel,
  syncPhase: aSharesSyncPhase,
  syncPercent: aSharesSyncPercent,
  syncStatus: aSharesSyncStatus,
  syncMessage: aSharesSyncMessage,
  dataDateRangeLabel: aSharesDataDateRangeLabel,
  dataDateRangeLoading: aSharesDataDateRangeLoading,
  openSyncModal: openASharesSyncModal,
  syncAShares,
} = useASharesSync(message, noopReload)
</script>

<style scoped src="./SyncView.styles.css"></style>
