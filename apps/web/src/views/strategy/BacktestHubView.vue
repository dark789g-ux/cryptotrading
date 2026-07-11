<template>
  <div class="backtest-hub-view workspace-page">
    <div class="workspace-page-header">
      <h1 class="workspace-page-title">策略回测</h1>
    </div>

    <n-card :bordered="false" size="small">
      <div class="hub-toolbar">
        <n-button type="primary" @click="showWizard = true">
          <template #icon><n-icon><add-outline /></n-icon></template>
          新建回测
        </n-button>
        <div class="hub-filters">
          <n-radio-group v-model:value="marketFilter" size="small" @update:value="onFilterChange">
            <n-radio-button value="all">全部</n-radio-button>
            <n-radio-button value="ashare">A股</n-radio-button>
            <n-radio-button value="crypto">加密</n-radio-button>
          </n-radio-group>
          <n-select
            v-if="marketFilter !== 'crypto'"
            v-model:value="statusDraft"
            :options="statusOptions"
            placeholder="状态"
            clearable
            style="width: 140px"
            @update:value="onFilterChange"
          />
          <n-input
            v-model:value="keywordDraft"
            placeholder="搜索名称"
            clearable
            style="width: 200px"
            @keydown.enter="onFilterChange"
            @clear="onFilterChange"
          >
            <template #prefix><n-icon><search-outline /></n-icon></template>
          </n-input>
        </div>
      </div>

      <n-data-table
        :columns="listColumns"
        :data="tableRows"
        :loading="listLoading"
        :pagination="pagination"
        :bordered="false"
        size="small"
        :scroll-x="980"
        :row-key="(r: HubBacktestRow) => r.key"
        :row-props="rowProps"
      />
    </n-card>

    <BacktestCreateWizardModal
      v-model:show="showWizard"
      @ashare-success="onAshareCreated"
      @crypto-success="onCryptoCreated"
    />

    <StrategyModal
      v-model:show="cryptoShowEdit"
      :is-edit="true"
      :strategy="cryptoEditing"
      @success="() => void reload()"
    />

    <RegimeBacktestDetailDrawer
      v-model:show="ashareShowDetail"
      :run="ashareDetailRun"
      :daily="ashareDaily"
      :daily-loading="ashareDailyLoading"
      :trades="ashareTrades"
      :trades-loading="ashareTradesLoading"
      :initial-capital="ashareInitialCapital"
    />

    <n-drawer
      v-model:show="cryptoShowDetail"
      width="min(1600px, 96vw)"
      placement="right"
      :mask-closable="false"
      class="glass-drawer"
    >
      <n-drawer-content
        :title="cryptoSelected ? `回测详情 · ${cryptoSelected.name}` : ''"
        closable
      >
        <BacktestDetail
          v-if="cryptoSelected"
          :strategy="cryptoSelected"
          :run="cryptoLatestRun"
          :loading="cryptoDetailLoading"
        />
      </n-drawer-content>
    </n-drawer>

    <n-modal
      v-model:show="cryptoShowProgress"
      :mask-closable="!cryptoProgressRunning"
      :closable="!cryptoProgressRunning"
      preset="card"
      :title="`回测进度 · ${cryptoProgressName}`"
      style="width: 480px"
    >
      <div v-if="cryptoProgressData" class="progress-body">
        <n-tag
          v-if="cryptoProgressData.status === 'running'"
          type="info" size="small" :bordered="false"
        >运行中</n-tag>
        <n-tag
          v-else-if="cryptoProgressData.status === 'done'"
          type="success" size="small" :bordered="false"
        >已完成</n-tag>
        <n-tag
          v-else-if="cryptoProgressData.status === 'error'"
          type="error" size="small" :bordered="false"
        >失败</n-tag>
        <n-progress
          type="line"
          :percentage="Math.round(Math.max(0, Math.min(100, cryptoProgressData.percent)))"
          :status="cryptoProgressData.status === 'done' ? 'success' : cryptoProgressData.status === 'error' ? 'error' : 'default'"
          indicator-placement="inside"
          style="margin: 14px 0"
        />
        <div v-if="cryptoProgressData.status === 'error'" class="progress-error">
          {{ cryptoProgressData.message || '回测失败' }}
        </div>
      </div>
      <div v-else class="progress-init">正在初始化…</div>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import {
  NButton, NCard, NDataTable, NDrawer, NDrawerContent, NIcon, NInput,
  NModal, NProgress, NRadioButton, NRadioGroup, NSelect, NTag,
  type DataTableColumns,
} from 'naive-ui'
import { AddOutline, SearchOutline, PlayOutline, TrashOutline, TimeOutline } from '@vicons/ionicons5'
import { colors } from '@/styles/tokens'
import type { RegimeBacktestRun } from '@/api/modules/strategy/regimeEngine'
import type { HubBacktestRow, HubMarketFilter } from '@/components/backtest/hubTypes'
import BacktestCreateWizardModal from '@/components/backtest/BacktestCreateWizardModal.vue'
import StrategyModal from '@/components/backtest/StrategyModal.vue'
import BacktestDetail from '@/components/backtest/BacktestDetail.vue'
import RegimeBacktestDetailDrawer from '@/components/strategy/regime-backtest/RegimeBacktestDetailDrawer.vue'
import { useHubAshareBacktest } from '@/composables/backtest/useHubAshareBacktest'
import { useHubCryptoBacktest } from '@/composables/backtest/useHubCryptoBacktest'

const showWizard = ref(false)
const marketFilter = ref<HubMarketFilter>('all')
const statusDraft = ref<string | null>(null)
const keywordDraft = ref('')
const statusApplied = ref<string | null>(null)
const keywordApplied = ref('')
const hubPage = ref(1)
const hubPageSize = 20

const ashare = useHubAshareBacktest()
const {
  showDetail: ashareShowDetail,
  detailRun: ashareDetailRun,
  detailInitialCapital: ashareInitialCapital,
  dailyRows: ashareDaily,
  dailyLoading: ashareDailyLoading,
  tradesRows: ashareTrades,
  tradesLoading: ashareTradesLoading,
} = ashare

const crypto = useHubCryptoBacktest()
const {
  showDetailDrawer: cryptoShowDetail,
  selectedStrategy: cryptoSelected,
  latestRun: cryptoLatestRun,
  detailLoading: cryptoDetailLoading,
  showProgressModal: cryptoShowProgress,
  progressModalStrategyName: cryptoProgressName,
  progressModalData: cryptoProgressData,
  isProgressRunning: cryptoProgressRunning,
  showEditModal: cryptoShowEdit,
  editingStrategy: cryptoEditing,
} = crypto

const statusOptions = [
  { label: '等待中', value: 'pending' },
  { label: '运行中', value: 'running' },
  { label: '已完成', value: 'completed' },
  { label: '失败', value: 'failed' },
]

const listLoading = computed(() => {
  if (marketFilter.value === 'ashare') return ashare.loading.value
  if (marketFilter.value === 'crypto') return crypto.loading.value
  return ashare.loading.value || crypto.loading.value
})

const tableRows = computed(() => {
  if (marketFilter.value === 'ashare') return ashare.hubRows.value
  if (marketFilter.value === 'crypto') return crypto.hubRows.value
  const merged = [...ashare.hubRows.value, ...crypto.hubRows.value]
  merged.sort((a, b) => b.createdAtMs - a.createdAtMs)
  const start = (hubPage.value - 1) * hubPageSize
  return merged.slice(start, start + hubPageSize)
})

const listTotal = computed(() => {
  if (marketFilter.value === 'ashare') return ashare.total.value
  if (marketFilter.value === 'crypto') return crypto.total.value
  return ashare.hubRows.value.length + crypto.hubRows.value.length
})

const pagination = computed(() => {
  const merged = marketFilter.value === 'all'
  return {
    page: merged ? hubPage.value : marketFilter.value === 'ashare' ? ashare.page.value : crypto.page.value,
    pageSize: merged ? hubPageSize : marketFilter.value === 'ashare' ? ashare.pageSize.value : crypto.pageSize.value,
    itemCount: listTotal.value,
    pageSizes: [10, 20, 50],
    showSizePicker: !merged,
    onChange: (p: number) => {
      if (merged) { hubPage.value = p; return }
      if (marketFilter.value === 'ashare') { ashare.page.value = p; void reload() }
      else { crypto.page.value = p; void reload() }
    },
    onUpdatePageSize: (s: number) => {
      if (merged) return
      if (marketFilter.value === 'ashare') { ashare.pageSize.value = s; ashare.page.value = 1 }
      else { crypto.pageSize.value = s; crypto.page.value = 1 }
      void reload()
    },
  }
})

function rowProps(row: HubBacktestRow) {
  return {
    style: 'cursor: pointer',
    onClick: () => {
      if (row.market === 'ashare') void ashare.openDetail(row.id)
      else void crypto.openDetail(row.id)
    },
  }
}

const listColumns: DataTableColumns<HubBacktestRow> = [
  {
    title: '市场', key: 'market', width: 72, fixed: 'left',
    render: (row) =>
      h(NTag, { type: row.market === 'ashare' ? 'success' : 'warning', bordered: false, size: 'small' }, {
        default: () => (row.market === 'ashare' ? 'A股' : '加密'),
      }),
  },
  {
    title: '名称', key: 'name', width: 200, ellipsis: { tooltip: true },
    render: (row) =>
      h('div', [
        h('div', row.name),
        h('div', { style: 'font-size:12px;color:var(--color-text-secondary)' }, row.subtitle),
      ]),
  },
  {
    title: '状态', key: 'status', width: 120,
    render: (row) =>
      h(NTag, { type: row.statusType, bordered: false, size: 'small' }, { default: () => row.statusLabel }),
  },
  {
    title: '收益', key: 'metric', width: 90,
    render: (row) => {
      const up = row.metric.startsWith('+') || (!row.metric.startsWith('-') && row.metric !== '-')
      const down = row.metric.startsWith('-') && row.metric !== '-'
      if (row.metric === '-') return '-'
      return h('span', {
        style: { color: down ? colors.error.DEFAULT : up ? colors.success.DEFAULT : undefined },
      }, row.metric)
    },
  },
  {
    title: '创建时间', key: 'createdAt', width: 160,
    render: (row) => (row.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN') : '-'),
  },
  {
    title: '操作', key: 'actions', width: 120, fixed: 'right',
    render: (row) => {
      if (row.market === 'ashare') {
        return h('div', { style: 'display:flex;gap:4px', onClick: (e: Event) => e.stopPropagation() }, [
          h(NButton, {
            size: 'tiny', quaternary: true, type: 'error',
            onClick: () => void ashare.remove(row.id),
          }, { default: () => '删除' }),
        ])
      }
      const running = crypto.pollingIds.value.has(row.id)
      return h('div', { style: 'display:flex;gap:4px', onClick: (e: Event) => e.stopPropagation() }, [
        h(NButton, {
          size: 'tiny', quaternary: true, type: 'primary',
          onClick: () => void crypto.openRun(row.id, row.name),
        }, { icon: () => h(NIcon, null, { default: () => h(running ? TimeOutline : PlayOutline) }) }),
        h(NButton, {
          size: 'tiny', quaternary: true,
          onClick: () => void crypto.openEdit(row.id),
        }, { default: () => '编辑' }),
        h(NButton, {
          size: 'tiny', quaternary: true, type: 'error',
          onClick: () => crypto.confirmDelete(row.id, row.name),
        }, { icon: () => h(NIcon, null, { default: () => h(TrashOutline) }) }),
      ])
    },
  },
]

async function reload() {
  const kw = keywordApplied.value
  const st = statusApplied.value || undefined
  if (marketFilter.value === 'ashare') {
    await ashare.loadList({ status: st, keyword: kw || undefined })
  } else if (marketFilter.value === 'crypto') {
    await crypto.loadList(kw || undefined)
  } else {
    ashare.page.value = 1
    crypto.page.value = 1
    hubPage.value = 1
    ashare.pageSize.value = 50
    crypto.pageSize.value = 50
    await Promise.all([
      ashare.loadList({ status: st, keyword: kw || undefined }),
      crypto.loadList(kw || undefined),
    ])
  }
}

function onFilterChange() {
  statusApplied.value = statusDraft.value
  keywordApplied.value = keywordDraft.value
  hubPage.value = 1
  ashare.page.value = 1
  crypto.page.value = 1
  void reload()
}

function onAshareCreated(run: RegimeBacktestRun) {
  ashare.onCreateSuccess(run)
  marketFilter.value = 'ashare'
  void reload()
}

function onCryptoCreated() {
  marketFilter.value = 'crypto'
  void reload()
}

onMounted(() => void reload())
</script>

<style scoped>
.backtest-hub-view { max-width: 1400px; padding: 16px; }
.hub-toolbar {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 16px; gap: 12px; flex-wrap: wrap;
}
.hub-filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.progress-body { padding: 4px 0; }
.progress-error {
  margin-top: 6px; padding: 8px 12px; border-radius: 6px; font-size: 13px;
  background: color-mix(in srgb, var(--color-error) 8%, transparent);
  color: var(--color-error);
}
.progress-init {
  color: var(--color-text-secondary); font-size: 13px; text-align: center; padding: 24px 0;
}
</style>
