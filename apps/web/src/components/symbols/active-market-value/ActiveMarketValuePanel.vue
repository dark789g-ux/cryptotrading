<template>
  <div class="active-mv-panel">
    <div class="panel-header">
      <div class="panel-header-main">
        <h2 class="panel-title">活跃市值（0AMV）</h2>
        <p class="panel-subtitle">中证A股指数 930903.CSI 活跃市值指标</p>
        <!-- 0AMV 计算公式（默认收起）。口径锚定后端 oamv.service.ts calc0amv：常数 OAMVN=10 / OAMVK=0.87 -->
        <n-collapse class="formula-collapse">
          <n-collapse-item title="计算公式" name="formula">
            <div class="formula-body">
              <p class="formula-line"><span class="formula-var">V1</span> = SMA(成交额, 10) ÷ 1,000,000</p>
              <p class="formula-line"><span class="formula-var">V3</span> = MA(REF(收盘, 1), 5)</p>
              <p class="formula-line">
                <span class="formula-var">0AMV</span>(开 / 高 / 低 / 收) = V1 × 当日对应价 ÷ V3 × 0.1 × 0.87
              </p>
              <p class="formula-note">
                数据源：中证A股指数 930903.CSI 日线（Tushare index_daily）。成交额取 amount（千元）× 1000 转为元；
                SMA 为通达信式递推 SMA(X, 10, 1) = (X + 9 × 前值) ÷ 10；常数 OAMVK = 0.87。
                副图 MA / KDJ / MACD 均为 0AMV 这条 OHLC 序列上再计算的标准指标。
              </p>
            </div>
          </n-collapse-item>
        </n-collapse>
      </div>
      <n-button :loading="syncing" @click="handleSync">
        <template #icon><n-icon><sync-outline /></n-icon></template>
        同步数据
      </n-button>
    </div>

    <!-- 象限状态卡 -->
    <n-card :bordered="false" class="regime-status-card">
      <n-spin :show="regimeLoading">
        <div v-if="regimeData" class="regime-card-body">
          <div class="regime-card-left">
            <span class="regime-card-label">当前象限</span>
            <regime-badge
              :label="regimeData.activeConfig?.entry?.label ?? '未知'"
              :color-index="regimeData.activeConfig?.entryIndex ?? 0"
            />
            <n-text v-if="regimeData.regime === 'unknown'" type="warning" class="regime-unknown-hint">
              数据缺失，无法识别象限
            </n-text>
          </div>
          <div class="regime-card-divider" />
          <div class="regime-card-right">
            <template v-if="regimeData.activeConfig">
              <span class="regime-card-label">生效配置</span>
              <span class="regime-config-desc">
                v{{ regimeData.activeConfig.version }}
                <template v-if="regimeData.activeConfig.note"> · {{ regimeData.activeConfig.note }}</template>
              </span>
              <template v-if="regimeData.activeConfig.entry">
                <span class="regime-card-label regime-card-label--top">象限动作</span>
                <n-tag
                  v-if="regimeData.activeConfig.entry.action === 'flat'"
                  size="small"
                  type="warning"
                  :bordered="false"
                >
                  空仓
                </n-tag>
                <n-tag
                  v-else
                  size="small"
                  type="success"
                  :bordered="false"
                >
                  开仓
                </n-tag>
              </template>
              <template v-else-if="regimeData.regime !== 'unknown'">
                <span class="regime-card-label regime-card-label--top">象限动作</span>
                <n-text class="regime-config-desc">该象限无配置条目</n-text>
              </template>
            </template>
            <template v-else>
              <span class="regime-card-label">生效配置</span>
              <n-text :depth="3" class="regime-config-desc">无生效配置</n-text>
            </template>
          </div>
        </div>
        <div v-else-if="!regimeLoading" class="regime-card-empty">
          <n-text :depth="3">象限数据加载失败</n-text>
        </div>
      </n-spin>
    </n-card>

    <n-card :bordered="false">
      <n-spin :show="loading">
        <kline-chart
          v-if="chartData.length > 0"
          :data="chartData"
          height="600px"
          show-toolbar
          granularity="date"
          :range="oamvRange"
          prefs-key="oamv"
          :available-subplots="oamvAvailableSubplots"
          :symbol-code="'930903.CSI'"
          :symbol-name="'中证A股指数'"
          @update:range="onOamvRangeChange"
        />
        <n-empty v-else description="暂无数据，请先同步" />
      </n-spin>
    </n-card>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ActiveMarketValuePanel' })

import { computed, onActivated, ref } from 'vue'
import { NButton, NCard, NCollapse, NCollapseItem, NEmpty, NIcon, NSpin, NTag, NText, useMessage } from 'naive-ui'
import { SyncOutline } from '@vicons/ionicons5'
import KlineChart from '@/components/kline/KlineChart.vue'
import RegimeBadge from '@/components/regime/RegimeBadge.vue'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { oamvApi, type OamvData } from '@/api/modules/market/oamv'
import { regimeEngineApi, type RegimeTodaySummary } from '@/api/modules/strategy/regimeEngine'
import type { KlineChartBar } from '@/api/modules/market/symbols'
import { useKlineRangePicker, type KlineRangeDates } from '@/composables/kline/useKlineRangePicker'
import { msToYyyymmdd } from '@/composables/kline/klineDateRange'
import { mapOamvToChartBar } from './oamvChartMapping'

const message = useMessage()

// 0AMV 面板：仅保留 KDJ / MACD，不含 VOL / BRICK（无成交量 / 砖图概念）
const oamvAvailableSubplots: SubplotKey[] = ['KDJ', 'MACD']
const loading = ref(false)
const syncing = ref(false)
const oamvData = ref<OamvData[]>([])

const regimeLoading = ref(false)
const regimeData = ref<RegimeTodaySummary | null>(null)

const chartData = computed<KlineChartBar[]>(() => oamvData.value.map(mapOamvToChartBar))

// 默认窗口取最近 DEFAULT_DAYS 条（面板定位"看近期象限"）；选了区间则按 trade_date 闭区间重查（后端忽略 days）。
const DEFAULT_DAYS = 250

// B 类服务端重查：选区间 → 以 start/end 重查；清空 → 回默认窗口（days=DEFAULT_DAYS）。
const { range: oamvRange, onRangeUpdate: onOamvRangeChange } = useKlineRangePicker((r) => loadData(r))

function currentRangeDates(): KlineRangeDates | null {
  const r = oamvRange.value
  return r ? { startDate: msToYyyymmdd(r[0]), endDate: msToYyyymmdd(r[1]) } : null
}

// rangeDates 默认沿用当前选区：onActivated 重激活时保留用户已选区间，不被重置回默认窗口。
async function loadData(rangeDates: KlineRangeDates | null = currentRangeDates()) {
  loading.value = true
  try {
    oamvData.value = await oamvApi.getData(DEFAULT_DAYS, rangeDates ?? undefined)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '加载数据失败')
  } finally {
    loading.value = false
  }
}

async function loadRegime() {
  regimeLoading.value = true
  try {
    regimeData.value = await regimeEngineApi.getToday()
  } catch {
    // 静默：象限卡展示失败态，不打断主图加载
  } finally {
    regimeLoading.value = false
  }
}

async function handleSync() {
  syncing.value = true
  try {
    const result = await oamvApi.sync()
    message.success(`同步完成，共 ${result.synced} 条数据`)
    await Promise.all([loadData(), loadRegime()])
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '同步失败')
  } finally {
    syncing.value = false
  }
}

onActivated(() => {
  void loadData()
  void loadRegime()
})
</script>

<style scoped>
.active-mv-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.panel-header-main {
  flex: 1;
  min-width: 0;
}

.panel-title {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
}

.panel-subtitle {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
}

/* 0AMV 计算公式折叠块 */
.formula-collapse {
  margin-top: 10px;
  max-width: 720px;
}

.formula-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.formula-line {
  margin: 0;
  font-family: ui-monospace, 'Cascadia Code', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.7;
  color: var(--color-text-secondary);
}

.formula-var {
  font-weight: 600;
  color: var(--color-text);
}

.formula-note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

/* 象限状态卡 */
.regime-status-card {
  /* compact: don't make card too tall */
}

.regime-card-body {
  display: flex;
  align-items: center;
  gap: 0;
  min-height: 52px;
}

.regime-card-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.regime-card-divider {
  width: 1px;
  height: 36px;
  background: var(--color-border);
  margin: 0 24px;
  flex-shrink: 0;
}

.regime-card-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.regime-card-label {
  font-size: 12px;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.regime-card-label--top {
  margin-left: 8px;
}

.regime-config-desc {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.regime-unknown-hint {
  font-size: 12px;
  margin-left: 4px;
}

.regime-card-empty {
  padding: 8px 0;
  font-size: 13px;
}
</style>
