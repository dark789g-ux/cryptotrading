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

            <!-- Card 1：加密货币 -->
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

              <div class="data-source-actions">
                <n-button block secondary :loading="saving" @click="saveConfig">保存配置</n-button>
                <n-button
                  block
                  secondary
                  type="primary"
                  :disabled="cryptoSyncing"
                  @click="openCryptoModal"
                >
                  <template #icon><n-icon><sync-outline /></n-icon></template>
                  配置并同步
                </n-button>
              </div>
            </section>

            <!-- Card 2：A 股 -->
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
                <div class="source-note">
                  打开同步面板后可选择全量或增量同步，并查看同步进度。
                </div>
              </div>

              <div class="data-source-actions">
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

            <!-- Card 3：资金流向 -->
            <section class="data-source-card data-source-card--moneyflow">
              <div class="data-source-header">
                <div class="data-source-icon">
                  <n-icon><swap-horizontal-outline /></n-icon>
                </div>
                <div class="data-source-heading">
                  <span class="data-source-eyebrow">Money Flow</span>
                  <h3 class="data-source-title">资金流向数据</h3>
                  <p class="data-source-desc">同花顺/东方财富资金流向，按日期范围同步个股、行业、板块、大盘四个维度。</p>
                </div>
              </div>

              <div class="data-source-body">
                <div class="source-note">
                  点击按钮选择日期范围，同步个股、行业、板块、大盘四个维度的资金流向数据。
                </div>
              </div>

              <div class="data-source-actions">
                <n-button
                  block
                  secondary
                  type="primary"
                  :loading="moneyFlowSyncing"
                  @click="openMoneyFlowModal"
                >
                  <template #icon><n-icon><swap-horizontal-outline /></n-icon></template>
                  配置并同步
                </n-button>
              </div>
            </section>

            <!-- Card 4：行业/概念目录 -->
            <section class="data-source-card data-source-card--index-catalog">
              <div class="data-source-header">
                <div class="data-source-icon">
                  <n-icon><cloud-download-outline /></n-icon>
                </div>
                <div class="data-source-heading">
                  <span class="data-source-eyebrow">Index Catalog</span>
                  <h3 class="data-source-title">行业/概念目录与成分股</h3>
                  <p class="data-source-desc">同步同花顺行业指数（type=I）和概念指数（type=N）目录，并刷新各板块的成分股关系。</p>
                </div>
              </div>

              <div class="data-source-body">
                <!-- 进度区（同步中显示） -->
                <div v-if="indexCatalogProgressVisible && !indexCatalogFinished" class="source-progress">
                  <div class="source-progress-head">
                    <span>{{ indexCatalogSse.phase.value || '准备中' }}</span>
                    <span>{{ Math.round(indexCatalogSse.percent.value) }}%</span>
                  </div>
                  <n-progress
                    type="line"
                    :percentage="Math.round(indexCatalogSse.percent.value)"
                    :status="indexCatalogSse.status.value === 'error' ? 'error' : 'default'"
                    indicator-placement="inside"
                  />
                  <div class="source-progress-msg">{{ indexCatalogSse.message.value }}</div>
                </div>

                <!-- summary 区（完成后显示） -->
                <div v-if="indexCatalogFinished" class="source-summary">
                  <div class="source-summary-row">
                    <span class="source-summary-item">行业目录：写入 {{ indexCatalogFinished.summary.industryCatalog?.success ?? 0 }} / 失败 {{ indexCatalogFinished.summary.industryCatalog?.errors?.length ?? 0 }}</span>
                    <span class="source-summary-item">概念目录：写入 {{ indexCatalogFinished.summary.conceptCatalog?.success ?? 0 }} / 失败 {{ indexCatalogFinished.summary.conceptCatalog?.errors?.length ?? 0 }}</span>
                    <span class="source-summary-item">行业成员：写入 {{ indexCatalogFinished.summary.industryMembers?.success ?? 0 }} / 失败 {{ indexCatalogFinished.summary.industryMembers?.errors?.length ?? 0 }}</span>
                    <span class="source-summary-item">概念成员：写入 {{ indexCatalogFinished.summary.conceptMembers?.success ?? 0 }} / 失败 {{ indexCatalogFinished.summary.conceptMembers?.errors?.length ?? 0 }}</span>
                    <span class="source-summary-item">清理：删除 {{ indexCatalogFinished.summary.cleanup?.success ?? 0 }} / 失败 {{ indexCatalogFinished.summary.cleanup?.errors?.length ?? 0 }}</span>
                  </div>
                </div>

                <div v-if="!indexCatalogProgressVisible && !indexCatalogFinished" class="source-note">
                  点击按钮开始同步行业/概念目录及成分股数据。
                </div>
              </div>

              <div class="data-source-actions">
                <n-button
                  block
                  secondary
                  type="primary"
                  :loading="indexCatalogSyncing"
                  :disabled="indexCatalogSyncing"
                  @click="startIndexCatalogSync()"
                >
                  <template #icon><n-icon><cloud-download-outline /></n-icon></template>
                  开始同步
                </n-button>
              </div>
            </section>

            <!-- Card 5：0AMV -->
            <section class="data-source-card data-source-card--oamv">
              <div class="data-source-header">
                <div class="data-source-icon">
                  <n-icon><trending-up-outline /></n-icon>
                </div>
                <div class="data-source-heading">
                  <span class="data-source-eyebrow">Active Market Value</span>
                  <h3 class="data-source-title">活跃市值（0AMV）</h3>
                  <p class="data-source-desc">中证A股指数 930903.CSI 的活跃市值指标，用于衡量 A 股市场活跃度。</p>
                </div>
              </div>

              <div class="data-source-body">
                <div class="source-note">
                  中证A股指数 930903.CSI 的活跃市值指标，用于衡量 A 股市场活跃度。
                </div>
              </div>

              <div class="data-source-actions">
                <n-button
                  block
                  secondary
                  type="primary"
                  :loading="oamvSyncing"
                  @click="openOamvModal"
                >
                  <template #icon><n-icon><trending-up-outline /></n-icon></template>
                  配置并同步
                </n-button>
              </div>
            </section>

          </div>
        </n-form>
      </n-card>
    </div>

    <!-- A 股同步 Modal（沿用现有） -->
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

    <!-- 加密货币同步 Modal -->
    <data-sync-modal
      v-model:show="cryptoShow"
      title="同步加密货币数据"
      description="同步交易标的的多周期 K 线行情数据。"
      :icon="SyncOutline"
      :syncing="cryptoSyncing"
      v-model:sync-mode="cryptoSyncMode"
      v-model:sync-date-range="cryptoSyncDateRange"
      :data-date-range-label="cryptoDateRangeLabel"
      :data-date-range-loading="cryptoDateRangeLoading"
      :can-confirm="cryptoCanConfirm"
      @confirm="confirmCryptoSync"
    >
      <template #extra>
        <div v-if="cryptoProgressVisible" class="crypto-sync-progress">
          <div class="sync-progress-head">
            <span>{{ cryptoSse.phase.value || '同步中' }}</span>
            <span>{{ Math.round(cryptoSse.percent.value) }}%</span>
          </div>
          <n-progress
            type="line"
            :percentage="Math.round(cryptoSse.percent.value)"
            :status="cryptoSse.status.value === 'error' ? 'error' : cryptoSse.status.value === 'done' ? 'success' : 'default'"
            indicator-placement="inside"
          />
        </div>
      </template>
    </data-sync-modal>

    <!-- 资金流向同步 Modal -->
    <data-sync-modal
      v-model:show="moneyFlowShow"
      title="同步资金流向数据"
      description="同花顺/东方财富资金流向，同步个股、行业、板块、大盘四个维度。"
      :icon="SwapHorizontalOutline"
      :syncing="moneyFlowSyncing"
      v-model:sync-mode="moneyFlowSyncMode"
      v-model:sync-date-range="moneyFlowSyncDateRange"
      :data-date-range-label="moneyFlowDateRangeLabel"
      :data-date-range-loading="moneyFlowDateRangeLoading"
      :can-confirm="moneyFlowCanConfirm"
      :finished="!!moneyFlowFinished"
      @confirm="confirmMoneyFlowSync"
    >
      <template #extra>
        <MoneyFlowSyncProgress
          :visible="moneyFlowProgressVisible"
          :sse="moneyFlowSse"
          :finished="moneyFlowFinished"
        />
      </template>
    </data-sync-modal>

    <!-- 0AMV 同步 Modal -->
    <data-sync-modal
      v-model:show="oamvShow"
      title="同步 0AMV 数据"
      description="中证A股指数 930903.CSI 的活跃市值指标。"
      :icon="TrendingUpOutline"
      :syncing="oamvSyncing"
      v-model:sync-mode="oamvSyncMode"
      v-model:sync-date-range="oamvSyncDateRange"
      :data-date-range-label="oamvDateRangeLabel"
      :data-date-range-loading="oamvDateRangeLoading"
      :can-confirm="oamvCanConfirm"
      @confirm="confirmOamvSync"
    />
  </div>
</template>

<script setup lang="ts">
import { useMessage, NButton, NCard, NCheckbox, NCheckboxGroup, NForm, NFormItem, NIcon, NProgress, NRadioButton, NRadioGroup, NSelect, NSpace } from 'naive-ui'
import { SyncOutline, CloudDownloadOutline, SwapHorizontalOutline, TrendingUpOutline } from '@vicons/ionicons5'
import { useSyncView } from '../../composables/hooks/useSyncView'
import ASharesSyncModal from '../../components/symbols/a-shares/ASharesSyncModal.vue'
import { useASharesSync } from '../../components/symbols/a-shares/useASharesSync'
import DataSyncModal from '../../components/sync/DataSyncModal.vue'
import MoneyFlowSyncProgress from '../../components/sync/MoneyFlowSyncProgress.vue'
import { useCryptoSync } from '../../components/sync/useCryptoSync'
import { useOamvSync } from '../../components/sync/useOamvSync'
import { useMoneyFlowSync } from '../../components/sync/useMoneyFlowSync'
import { useIndexCatalogSync } from '../../components/sync/useIndexCatalogSync'

const message = useMessage()
const noopReload = async () => {}

// 加密货币配置（时间周期、标的筛选）
const {
  syncConfig,
  symbolMode,
  symbolOptions,
  loadingSymbols,
  saving,
  saveConfig,
} = useSyncView()

// A 股 Modal
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

// 加密货币 Modal
const {
  show: cryptoShow,
  syncing: cryptoSyncing,
  syncMode: cryptoSyncMode,
  syncDateRange: cryptoSyncDateRange,
  dateRangeLabel: cryptoDateRangeLabel,
  dateRangeLoading: cryptoDateRangeLoading,
  canConfirm: cryptoCanConfirm,
  syncProgressVisible: cryptoProgressVisible,
  sse: cryptoSse,
  openModal: openCryptoModal,
  confirmSync: confirmCryptoSync,
} = useCryptoSync(message)

// 资金流向 Modal
const {
  show: moneyFlowShow,
  syncing: moneyFlowSyncing,
  syncMode: moneyFlowSyncMode,
  syncDateRange: moneyFlowSyncDateRange,
  dateRangeLabel: moneyFlowDateRangeLabel,
  dateRangeLoading: moneyFlowDateRangeLoading,
  canConfirm: moneyFlowCanConfirm,
  syncProgressVisible: moneyFlowProgressVisible,
  sse: moneyFlowSse,
  finished: moneyFlowFinished,
  openModal: openMoneyFlowModal,
  confirmSync: confirmMoneyFlowSync,
} = useMoneyFlowSync(message)

// 行业/概念目录同步
const {
  syncing: indexCatalogSyncing,
  syncProgressVisible: indexCatalogProgressVisible,
  sse: indexCatalogSse,
  finished: indexCatalogFinished,
  confirmSync: startIndexCatalogSync,
} = useIndexCatalogSync(message)

// 0AMV Modal
const {
  show: oamvShow,
  syncing: oamvSyncing,
  syncMode: oamvSyncMode,
  syncDateRange: oamvSyncDateRange,
  dateRangeLabel: oamvDateRangeLabel,
  dateRangeLoading: oamvDateRangeLoading,
  canConfirm: oamvCanConfirm,
  openModal: openOamvModal,
  confirmSync: confirmOamvSync,
} = useOamvSync(message)
</script>

<style scoped src="./SyncView.styles.css"></style>
