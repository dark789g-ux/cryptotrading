<template>
  <div class="regime-picks-view workspace-page workspace-page--medium">
    <!-- Header -->
    <div class="workspace-page-header">
      <div>
        <h1 class="workspace-page-title">Regime 选股清单</h1>
        <p class="page-subtitle">0AMV 象限识别 + 按 active 配置生成的当日选股清单</p>
      </div>
      <div class="header-actions">
        <n-date-picker
          v-model:value="selectedDateMs"
          type="date"
          :is-date-disabled="isDateDisabled"
          clearable
          style="width: 160px"
          @update:value="onDateChange"
        />
        <n-button
          v-if="isAdmin"
          type="primary"
          :loading="running"
          @click="handleRunDaily"
        >
          跑当日
        </n-button>
      </div>
    </div>

    <!-- 象限状态行 -->
    <div v-if="picks !== null" class="regime-summary-row">
      <div class="regime-summary-left">
        <span class="regime-summary-label">象限</span>
        <regime-badge
          :label="(markerRow?.snapshot?.label as string) || currentRegime"
          :color-index="0"
        />
        <span v-if="configVersion !== null" class="regime-summary-version">
          v{{ configVersion }}
        </span>
      </div>
      <div v-if="configEntry" class="regime-summary-right">
        <n-button
          size="small"
          ghost
          @click="showEvidence = true"
        >
          查看配置详情
        </n-button>
      </div>
    </div>

    <!-- 主内容 -->
    <n-card :bordered="false">
      <n-spin :show="loading">
        <!-- 空仓日 -->
        <div v-if="flatStatus" class="regime-status-message">
          <n-result status="warning" :title="flatStatus.title" :description="flatStatus.desc" />
        </div>

        <!-- 选股表格 -->
        <template v-else-if="picks !== null && picks.length > 0">
          <n-data-table
            :columns="columns"
            :data="picks"
            :pagination="pagination"
            :bordered="false"
            size="small"
          />
        </template>

        <!-- 未跑 / 无数据 -->
        <n-empty
          v-else-if="picks !== null && picks.length === 0 && !loading"
          description="无记录：未运行或无命中"
        />

        <!-- 初始占位 -->
        <n-empty
          v-else-if="picks === null && !loading"
          description="请选择交易日"
        />
      </n-spin>
    </n-card>

    <!-- Evidence 弹窗 -->
    <AppModal
      v-model:show="showEvidence"
      title="配置条目详情"
      width="min(720px, 96vw)"
    >
      <div v-if="configEntry" class="evidence-body">
        <n-descriptions :columns="1" bordered size="small">
          <n-descriptions-item label="动作">
            <n-tag :type="configEntry.action === 'flat' ? 'warning' : 'success'" :bordered="false" size="small">
              {{ configEntry.action === 'flat' ? '空仓' : '开仓' }}
            </n-tag>
          </n-descriptions-item>
          <n-descriptions-item v-if="configEntry.label" label="标签">
            {{ configEntry.label }}
          </n-descriptions-item>
          <n-descriptions-item v-if="configEntry.exitMode" label="出场模式">
            {{ configEntry.exitMode }}
          </n-descriptions-item>
        </n-descriptions>

        <template v-if="configEntry.entryConditions">
          <div class="evidence-section-title">入场条件（entryConditions）</div>
          <n-scrollbar style="max-height: 200px">
            <pre class="evidence-json">{{ JSON.stringify(configEntry.entryConditions, null, 2) }}</pre>
          </n-scrollbar>
        </template>

        <template v-if="configEntry.exitParams">
          <div class="evidence-section-title">出场参数（exitParams）</div>
          <pre class="evidence-json">{{ JSON.stringify(configEntry.exitParams, null, 2) }}</pre>
        </template>

        <template v-if="evidenceExtra">
          <div class="evidence-section-title">其他字段</div>
          <n-scrollbar style="max-height: 200px">
            <pre class="evidence-json">{{ JSON.stringify(evidenceExtra, null, 2) }}</pre>
          </n-scrollbar>
        </template>
      </div>
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NDatePicker,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NResult,
  NScrollbar,
  NSpin,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { useAuth } from '@/composables/hooks/useAuth'
import { ApiError } from '@/api/client'
import {
  regimeEngineApi,
  type RegimeDailyPick,
  type RegimeConfigEntry,
  type RegimeResult,
  type RegimeStrategyConfig,
} from '@/api/modules/strategy/regimeEngine'
import RegimeBadge from '@/components/regime/RegimeBadge.vue'
import AppModal from '@/components/common/AppModal.vue'

const message = useMessage()
const auth = useAuth()
const isAdmin = computed(() => auth.isAdmin.value)

// ── 日期状态 ─────────────────────────────────────────────────────────────────

// 初始值：今天本地午夜 ms（参照 aSharesFormatters.ts 规范用本地方法）
function todayLocalMs(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function msToTradeDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

const selectedDateMs = ref<number | null>(todayLocalMs())
const selectedTradeDate = computed<string>(() =>
  selectedDateMs.value !== null ? msToTradeDate(selectedDateMs.value) : '',
)

function isDateDisabled(ts: number): boolean {
  return ts > todayLocalMs()
}

// ── 数据加载 ─────────────────────────────────────────────────────────────────

const loading = ref(false)
const picks = ref<RegimeDailyPick[] | null>(null)

// 从 picks 中取元数据（marker 行 regime/configVersion/action）
// trade 日无标记行（tsCode=null），此时回退 picks[0]（trade 行自带 regime/configVersion）
const markerRow = computed<RegimeDailyPick | null>(() => {
  if (!picks.value || picks.value.length === 0) return null
  return picks.value.find((p) => p.tsCode === null) ?? picks.value[0]
})

const currentRegime = computed<RegimeResult>(() => markerRow.value?.regime ?? 'unknown')
const configVersion = computed<number | null>(() => markerRow.value?.configVersion ?? null)

// flat / unknown 状态
const flatStatus = computed<{ title: string; desc: string } | null>(() => {
  if (picks.value === null) return null
  const marker = markerRow.value
  if (!marker) return null
  if (marker.action === 'unknown') {
    return { title: '数据缺失', desc: '当日 0AMV 指标数据不完整，象限无法识别' }
  }
  if (marker.action === 'flat') {
    const label =
      marker.snapshot && typeof marker.snapshot['label'] === 'string'
        ? marker.snapshot['label']
        : ''
    return {
      title: '本象限空仓',
      desc: label ? `配置理由：${label}` : '当前象限配置为空仓，无选股清单',
    }
  }
  return null
})

// 生效配置条目（按当日 configVersion + regime 从 configs 缓存中定位）
const configEntry = ref<RegimeConfigEntry | null>(null)

// 所有历史版本配置（一次性加载，用于历史日 evidence 查找）
const configsCache = ref<RegimeStrategyConfig[]>([])

async function ensureConfigsCache() {
  if (configsCache.value.length > 0) return
  try {
    configsCache.value = await regimeEngineApi.listConfigs()
  } catch {
    // configs 加载失败只降级 evidence 按钮，不影响 picks 展示
  }
}

// 根据 picks 结果更新 configEntry（需 configsCache 已加载）
function resolveConfigEntry() {
  const row = markerRow.value
  if (!row || row.configVersion === null) {
    configEntry.value = null
    return
  }
  const regime = row.regime
  if (regime === 'unknown') {
    configEntry.value = null
    return
  }
  const found = configsCache.value.find((c) => c.version === row.configVersion)
  configEntry.value =
    found?.config?.quadrants?.find((q) => q.key === regime) ?? null
}

async function loadPicks(tradeDate: string) {
  if (!tradeDate || tradeDate.length !== 8) return
  loading.value = true
  picks.value = null
  configEntry.value = null
  let picksOk = false
  try {
    picks.value = await regimeEngineApi.getPicks(tradeDate)
    picksOk = true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '加载失败'
    message.error(msg)
    picks.value = []
  } finally {
    loading.value = false
  }
  if (!picksOk) return
  // picks 加载成功后，独立加载 configs（失败不影响表格）
  await ensureConfigsCache()
  resolveConfigEntry()
}

function onDateChange(val: number | null) {
  if (val === null) {
    picks.value = null
    configEntry.value = null
    return
  }
  void loadPicks(msToTradeDate(val))
}

// ── evidence 弹窗 ────────────────────────────────────────────────────────────

const showEvidence = ref(false)

// 剔除已有专属字段后的其余字段
const KNOWN_KEYS = ['action', 'label', 'entryConditions', 'exitMode', 'exitParams']
const evidenceExtra = computed<Record<string, unknown> | null>(() => {
  if (!configEntry.value) return null
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(configEntry.value)) {
    if (!KNOWN_KEYS.includes(k)) extra[k] = v
  }
  return Object.keys(extra).length > 0 ? extra : null
})

// ── 表格列 ───────────────────────────────────────────────────────────────────

const columns: DataTableColumns<RegimeDailyPick> = [
  {
    title: '代码',
    key: 'tsCode',
    width: 120,
    render: (row) => row.tsCode ?? '-',
  },
  {
    title: '名称',
    key: 'name',
    render: (row) => row.name ?? '-',
  },
  {
    title: '收盘价',
    key: 'close',
    width: 100,
    render: (row) => {
      const close = row.snapshot?.['close']
      if (close === null || close === undefined) return '-'
      return h('span', {}, String(Number(close).toFixed(2)))
    },
  },
  {
    title: '动作',
    key: 'action',
    width: 80,
    render: (row) => {
      const actionMap: Record<string, { type: 'success' | 'warning' | 'default'; label: string }> = {
        trade: { type: 'success', label: '开仓' },
        flat: { type: 'warning', label: '空仓' },
        unknown: { type: 'default', label: '未知' },
      }
      const info = actionMap[row.action] ?? { type: 'default' as const, label: row.action }
      return h(NTag, { type: info.type, bordered: false, size: 'small' }, { default: () => info.label })
    },
  },
]

const pagination = {
  defaultPageSize: 10,
  pageSizes: [10, 20, 50],
  showSizePicker: true,
}

// ── 跑当日 ───────────────────────────────────────────────────────────────────

const running = ref(false)

async function handleRunDaily() {
  if (!selectedTradeDate.value) {
    message.warning('请先选择交易日')
    return
  }
  running.value = true
  try {
    const result = await regimeEngineApi.runDaily(selectedTradeDate.value)
    message.success(
      `运行完成：${result.regime} / ${result.action}，共 ${result.pickCount} 支标的`,
    )
    // 刷新清单
    await loadPicks(selectedTradeDate.value)
  } catch (err: unknown) {
    const msg =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : '运行失败'
    message.error(msg)
  } finally {
    running.value = false
  }
}

// ── 初始化 ───────────────────────────────────────────────────────────────────

onMounted(async () => {
  // 加载今日数据
  if (selectedDateMs.value !== null) {
    await loadPicks(msToTradeDate(selectedDateMs.value))
  }
})
</script>

<style scoped>
.regime-picks-view {
  padding: 16px;
}

.page-subtitle {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

/* 象限摘要行 */
.regime-summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: color-mix(in srgb, var(--color-surface-elevated) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
  border-radius: 10px;
}

.regime-summary-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.regime-summary-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.regime-summary-label {
  font-size: 12px;
  color: var(--color-text-muted);
}

.regime-summary-version {
  font-size: 12px;
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-border) 50%, transparent);
  padding: 1px 6px;
  border-radius: 4px;
}

/* 空仓/数据缺失提示 */
.regime-status-message {
  padding: 32px 0;
}

/* Evidence 弹窗内容 */
.evidence-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.evidence-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin-top: 4px;
}

.evidence-json {
  margin: 0;
  padding: 12px;
  font-size: 12px;
  font-family: 'Fira Code', 'Cascadia Code', Consolas, monospace;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--color-text-secondary);
  line-height: 1.5;
}
</style>
