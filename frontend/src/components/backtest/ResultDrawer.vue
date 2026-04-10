<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-overlay" @click="$emit('close')"></div>
    <div class="drawer" :class="{ open }">
      <div class="drawer-header">
        <div>
          <div class="drawer-title">{{ strategy?.name }}</div>
          <div class="drawer-sub">{{ strategy?.params?.date_start }} ~ {{ strategy?.params?.date_end }}</div>
        </div>
        <button class="modal-close" @click="$emit('close')"><X :size="18" /></button>
      </div>

      <div class="drawer-body">
        <div v-if="loading" class="loading-hint">加载结果中…</div>
        <div v-else-if="error" class="error-hint">{{ error }}</div>
        <template v-else-if="result">
          <!-- 汇总统计 -->
          <section class="section">
            <div class="section-label">汇总统计</div>
            <TradeStats :stats="result.stats" />
          </section>

          <!-- 净值曲线 -->
          <section class="section">
            <div class="section-label">净值曲线</div>
            <PortfolioChart :labels="result.portfolio?.labels" :values="result.portfolio?.values" />
          </section>

          <!-- 交易记录 -->
          <section class="section">
            <div class="section-label">交易记录（{{ result.total_positions }} 笔仓位）</div>
            <TradeTable
              :positions="result.positions"
              :selected="selectedTradeKey"
              @select-trade="onSelectTrade"
            />
          </section>

          <!-- K 线图（选中交易后显示） -->
          <section v-if="selectedTrade" class="section">
            <div class="section-label">
              {{ selectedTrade.symbol }} K 线图
              <span class="kline-range">{{ selectedTrade.entry_time.slice(0,10) }} ~ {{ selectedTrade.close_time.slice(0,10) }}</span>
            </div>
            <TradeKlineChart
              :symbol="selectedTrade.symbol"
              :interval="strategy?.params?.timeframe || '1h'"
              :trade="selectedTrade"
              :date-start="selectedTrade.entry_time.slice(0,10)"
              :date-end="selectedTrade.close_time.slice(0,10)"
            />
          </section>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import TradeStats from './TradeStats.vue'
import PortfolioChart from './PortfolioChart.vue'
import TradeTable from './TradeTable.vue'
import TradeKlineChart from './TradeKlineChart.vue'
import { api } from '../../composables/useApi.js'

const props = defineProps({
  open: Boolean,
  strategy: Object,
})
defineEmits(['close'])

const result = ref(null)
const loading = ref(false)
const error = ref('')
const selectedTrade = ref(null)
const selectedTradeKey = ref(null)

watch(() => [props.open, props.strategy], async ([open, strat]) => {
  if (!open || !strat) return
  if (!strat.last_backtest_at) { error.value = '尚未执行过回测'; return }
  loading.value = true; error.value = ''; result.value = null; selectedTrade.value = null
  try {
    result.value = await api.getBacktestResult(strat.id)
  } catch (e) {
    error.value = '加载失败：' + e.message
  } finally {
    loading.value = false
  }
})

function onSelectTrade(trade) {
  selectedTrade.value = trade
  selectedTradeKey.value = `${trade.symbol}_${trade.entry_time}`
}
</script>

<style scoped>
.drawer-title { font-size: 1rem; font-weight: 600; }
.drawer-sub { font-size: .82rem; color: var(--color-text-secondary); margin-top: 2px; }
.loading-hint, .error-hint {
  padding: 32px; text-align: center; color: var(--color-text-secondary);
}
.error-hint { color: var(--color-danger); }
.section { margin-bottom: 24px; }
.section-label {
  font-size: .8rem; font-weight: 600; color: var(--color-text-secondary);
  text-transform: uppercase; letter-spacing: .04em;
  margin-bottom: 10px; display: flex; align-items: center; gap: 8px;
}
.kline-range { font-weight: 400; text-transform: none; color: var(--color-text-secondary); }
</style>
