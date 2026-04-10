<template>
  <div class="trade-table-wrap">
    <table class="trade-table">
      <thead>
        <tr>
          <th>#</th>
          <th>交易对</th>
          <th>买入时间</th>
          <th>买入价</th>
          <th>卖出时间</th>
          <th>卖出价</th>
          <th>盈亏%</th>
          <th>持仓(h)</th>
          <th>止损类型</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in positions"
          :key="`${p.symbol}_${p.entry_time}`"
          :class="{ selected: selected === `${p.symbol}_${p.entry_time}`, profit: p.return_pct >= 0, loss: p.return_pct < 0 }"
          @click="$emit('select-trade', p)"
        >
          <td>{{ p.pos_no }}</td>
          <td class="sym">{{ p.symbol }}</td>
          <td>{{ p.entry_time.slice(0, 16) }}</td>
          <td>{{ p.entry_price }}</td>
          <td>{{ p.close_time.slice(0, 16) }}</td>
          <td>{{ p.sell_price }}</td>
          <td :class="p.return_pct >= 0 ? 'pos' : 'neg'">
            {{ p.return_pct >= 0 ? '+' : '' }}{{ p.return_pct?.toFixed(2) }}%
          </td>
          <td>{{ p.hold_candles }}</td>
          <td class="reason">{{ p.stop_types?.join(' / ') }}</td>
        </tr>
        <tr v-if="!positions.length">
          <td colspan="9" class="empty">暂无交易记录</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
defineProps({
  positions: { type: Array, default: () => [] },
  selected: { type: String, default: null },
})
defineEmits(['select-trade'])
</script>

<style scoped>
.trade-table-wrap { overflow-x: auto; }
.trade-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
thead { position: sticky; top: 0; z-index: 1; }
th { background: #f4f6f8; padding: 8px 10px; text-align: left; font-weight: 600; color: #555; white-space: nowrap; }
td { padding: 7px 10px; border-bottom: 1px solid var(--color-border-light); white-space: nowrap; }
tr { cursor: pointer; }
tr:hover td { background: #f8fafc; }
tr.selected td { background: #eaf4fd; }
.sym { font-weight: 500; }
.pos { color: var(--color-success); font-weight: 600; }
.neg { color: var(--color-danger); font-weight: 600; }
.reason { color: var(--color-text-secondary); font-size: .78rem; max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
.empty { text-align: center; color: var(--color-text-secondary); padding: 24px; }
</style>
