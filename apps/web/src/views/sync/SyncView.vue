<template>
  <div class="sync-view workspace-page workspace-page--medium">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">数据同步</h1>
    </div>

    <!-- 一键同步面板（前端编排） -->
    <n-card class="one-click-card" title="一键同步" :bordered="false"><OneClickSyncPanel :controller="oneClickCtrl" /></n-card>
    <div class="sync-grid">
      <!-- 同步配置 -->
      <n-card class="config-card" title="同步配置" :bordered="false">
        <n-form label-placement="top" class="sync-config-form">
          <div class="data-source-grid">

            <!-- Card 1：加密货币 -->
            <section class="data-source-card data-source-card--crypto">
              <DataSourceCardHeader
                :icon="SyncOutline"
                eyebrow="Crypto Market"
                title="加密货币数据"
                description="同步交易标的的多周期行情，支持全部标的或自定义范围。"
              />

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

            <!-- Card 2/3：A 股、资金流向（同构卡，v-for 渲染） -->
            <section
              v-for="card in syncCardsLead"
              :key="card.modifier"
              :class="`data-source-card data-source-card--${card.modifier}`"
            >
              <DataSourceCardHeader
                :icon="card.icon"
                :eyebrow="card.eyebrow"
                :title="card.title"
                :description="card.description"
              />
              <div class="data-source-body">
                <div class="source-note">{{ card.note }}</div>
              </div>
              <div class="data-source-actions">
                <n-button
                  block secondary type="primary"
                  :loading="card.loading.value"
                  :disabled="card.loading.value || oneClickRunning"
                  @click="card.onClick"
                >
                  <template #icon><n-icon><component :is="card.icon" /></n-icon></template>
                  配置并同步
                </n-button>
              </div>
            </section>

            <!-- Card 4：行业/概念目录 -->
            <section class="data-source-card data-source-card--index-catalog">
              <DataSourceCardHeader
                :icon="CloudDownloadOutline"
                eyebrow="Index Catalog"
                title="行业/概念目录与成分股"
                description="同步同花顺行业指数（type=I）和概念指数（type=N）目录，并刷新各板块的成分股关系。"
              />

              <div class="data-source-body">
                <IndexCatalogSyncProgress
                  :visible="indexCatalogProgressVisible"
                  :sse="indexCatalogSse"
                  :finished="indexCatalogFinished"
                />

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

            <!-- Card 5/6/7：指数日线、0AMV、基础数据（同构卡，v-for 渲染） -->
            <section
              v-for="card in syncCardsTail"
              :key="card.modifier"
              :class="`data-source-card data-source-card--${card.modifier}`"
            >
              <DataSourceCardHeader
                :icon="card.icon"
                :eyebrow="card.eyebrow"
                :title="card.title"
                :description="card.description"
              />
              <div class="data-source-body">
                <div class="source-note">{{ card.note }}</div>
              </div>
              <div class="data-source-actions">
                <n-button
                  block secondary type="primary"
                  :loading="card.loading.value"
                  :disabled="card.loading.value || oneClickRunning"
                  @click="card.onClick"
                >
                  <template #icon><n-icon><component :is="card.icon" /></n-icon></template>
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
        <SyncProgressBar :visible="cryptoProgressVisible" :sse="cryptoSse" />
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

    <!-- 指数日线 (ths_daily) 同步 Modal -->
    <data-sync-modal
      v-model:show="thsIndexDailyShow"
      title="同步指数日线 (ths_daily)"
      description="同花顺行业（type=I）/概念（type=N）指数日线 K 线 + 指标计算。"
      :icon="TrendingUpOutline"
      :syncing="thsIndexDailySyncing"
      v-model:sync-mode="thsIndexDailySyncMode"
      v-model:sync-date-range="thsIndexDailySyncDateRange"
      :data-date-range-label="thsIndexDailyDateRangeLabel"
      :data-date-range-loading="thsIndexDailyDateRangeLoading"
      :can-confirm="thsIndexDailyCanConfirm"
      :finished="!!thsIndexDailyFinished"
      @confirm="confirmThsIndexDailySync"
    >
      <template #extra>
        <SyncProgressBar
          :visible="thsIndexDailyProgressVisible"
          :sse="thsIndexDailySse"
          :finished="thsIndexDailyFinished"
        />
      </template>
    </data-sync-modal>

    <!-- 基础数据（trade_cal / stk_limit / suspend_d）同步 Modal -->
    <data-sync-modal
      v-model:show="baseDataShow"
      title="同步基础数据 (日历/涨跌停/停牌)"
      description="trade_cal / stk_limit / suspend_d，按依赖顺序串行同步。"
      :icon="CalendarOutline"
      :syncing="baseDataSyncing"
      v-model:sync-mode="baseDataSyncMode"
      v-model:sync-date-range="baseDataSyncDateRange"
      :data-date-range-label="baseDataDateRangeLabel"
      :data-date-range-loading="baseDataDateRangeLoading"
      :can-confirm="baseDataCanConfirm"
      :finished="!!baseDataFinished"
      @confirm="confirmBaseDataSync"
    >
      <template #extra>
        <SyncProgressBar
          :visible="baseDataProgressVisible"
          :sse="baseDataSse"
          :finished="baseDataFinished"
        />
      </template>
    </data-sync-modal>
  </div>
</template>

<script setup lang="ts">
import { useMessage, NButton, NCard, NCheckbox, NCheckboxGroup, NForm, NFormItem, NIcon, NRadioButton, NRadioGroup, NSelect, NSpace } from 'naive-ui'
import { SyncOutline, CloudDownloadOutline, SwapHorizontalOutline, TrendingUpOutline, CalendarOutline } from '@vicons/ionicons5'
import { useSyncView } from '../../composables/hooks/useSyncView'
import ASharesSyncModal from '../../components/symbols/a-shares/ASharesSyncModal.vue'
import { useASharesSync } from '../../components/symbols/a-shares/useASharesSync'
import DataSyncModal from '../../components/sync/DataSyncModal.vue'
import DataSourceCardHeader from '../../components/sync/DataSourceCardHeader.vue'
import SyncProgressBar from '../../components/sync/SyncProgressBar.vue'
import MoneyFlowSyncProgress from '../../components/sync/MoneyFlowSyncProgress.vue'
import IndexCatalogSyncProgress from '../../components/sync/IndexCatalogSyncProgress.vue'
import { useCryptoSync } from '../../components/sync/useCryptoSync'
import { useOamvSync } from '../../components/sync/useOamvSync'
import { useMoneyFlowSync } from '../../components/sync/useMoneyFlowSync'
import { useIndexCatalogSync } from '../../components/sync/useIndexCatalogSync'
import { useThsIndexDailySync } from '../../components/sync/useThsIndexDailySync'
import { useBaseDataSync } from '../../components/sync/useBaseDataSync'
import { computed, provide } from 'vue'
import OneClickSyncPanel from '../../components/sync/OneClickSyncPanel.vue'
import { useOneClickSync } from '../../components/sync/useOneClickSync'
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

// 指数日线 (ths_daily) Modal
const {
  show: thsIndexDailyShow,
  syncing: thsIndexDailySyncing,
  syncMode: thsIndexDailySyncMode,
  syncDateRange: thsIndexDailySyncDateRange,
  dateRangeLabel: thsIndexDailyDateRangeLabel,
  dateRangeLoading: thsIndexDailyDateRangeLoading,
  canConfirm: thsIndexDailyCanConfirm,
  syncProgressVisible: thsIndexDailyProgressVisible,
  sse: thsIndexDailySse,
  finished: thsIndexDailyFinished,
  openModal: openThsIndexDailyModal,
  confirmSync: confirmThsIndexDailySync,
} = useThsIndexDailySync(message)

// 基础数据（trade_cal / stk_limit / suspend_d）Modal
const {
  show: baseDataShow,
  syncing: baseDataSyncing,
  syncMode: baseDataSyncMode,
  syncDateRange: baseDataSyncDateRange,
  dateRangeLabel: baseDataDateRangeLabel,
  dateRangeLoading: baseDataDateRangeLoading,
  canConfirm: baseDataCanConfirm,
  syncProgressVisible: baseDataProgressVisible,
  sse: baseDataSse,
  finished: baseDataFinished,
  openModal: openBaseDataModal,
  confirmSync: confirmBaseDataSync,
} = useBaseDataSync(message)
// 一键同步顶层 controller（与下方 4 张相关卡片共享 running 状态）
const oneClickCtrl = useOneClickSync(message)
const oneClickRunning = computed(() => oneClickCtrl.running.value)
provide('oneClickRunning', oneClickRunning)

// 同构数据源卡配置（v-for 渲染，文案/图标/绑定逐字沿用各卡现状）
// lead 段：渲染在 crypto 之后、index-catalog 之前
const syncCardsLead = [
  {
    modifier: 'ashares',
    icon: CloudDownloadOutline,
    eyebrow: 'A-Share Market',
    title: 'A 股数据',
    description: 'TuShare 日线数据独立同步，与加密货币数据源并列管理。',
    note: '打开同步面板后可选择全量或增量同步，并查看同步进度。',
    loading: aSharesSyncing,
    onClick: openASharesSyncModal,
  },
  {
    modifier: 'moneyflow',
    icon: SwapHorizontalOutline,
    eyebrow: 'Money Flow',
    title: '资金流向数据',
    description: '同花顺/东方财富资金流向，按日期范围同步个股、行业、板块、大盘四个维度。',
    note: '点击按钮选择日期范围，同步个股、行业、板块、大盘四个维度的资金流向数据。',
    loading: moneyFlowSyncing,
    onClick: openMoneyFlowModal,
  },
]
// tail 段：渲染在 index-catalog 之后
const syncCardsTail = [
  {
    modifier: 'ths-index-daily',
    icon: TrendingUpOutline,
    eyebrow: 'THS Index Daily',
    title: '指数日线 (ths_daily)',
    description: '同花顺行业（type=I）/概念（type=N）指数日线 K 线 + 指标计算（MA/MACD/KDJ/BBI/BRICK）。',
    note: '按 trade_date 循环拉取，全市场 I+N 合计约 ~700 行/日，落库后按受影响指数重算指标。',
    loading: thsIndexDailySyncing,
    onClick: openThsIndexDailyModal,
  },
  {
    modifier: 'oamv',
    icon: TrendingUpOutline,
    eyebrow: 'Active Market Value',
    title: '活跃市值（0AMV）',
    description: '中证A股指数 930903.CSI 的活跃市值指标，用于衡量 A 股市场活跃度。',
    note: '中证A股指数 930903.CSI 的活跃市值指标，用于衡量 A 股市场活跃度。',
    loading: oamvSyncing,
    onClick: openOamvModal,
  },
  {
    modifier: 'base-data',
    icon: CalendarOutline,
    eyebrow: 'Base Data',
    title: '基础数据 (日历/涨跌停/停牌)',
    description: 'trade_cal / stk_limit / suspend_d，按依赖顺序串行同步',
    note: '交易日历、涨跌停价、停牌信息按依赖顺序串行拉取，作为 A 股策略与回测的基础数据底座。',
    loading: baseDataSyncing,
    onClick: openBaseDataModal,
  },
]
</script>

<style scoped src="./SyncView.styles.css"></style>
