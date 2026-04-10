<template>
  <div class="strategy-list">
    <div class="list-header">
      <h2 class="list-title">回测策略</h2>
      <button class="btn btn-primary btn-sm" @click="$emit('new')">
        <Plus :size="14" /> 新建策略
      </button>
    </div>

    <div v-if="!strategies.length" class="empty">暂无策略，点击「新建策略」开始</div>

    <table v-else>
      <thead>
        <tr>
          <th>策略名称</th>
          <th>类型</th>
          <th>创建时间</th>
          <th>上次回测</th>
          <th>收益率</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="s in strategies"
          :key="s.id"
          :class="{ active: selectedId === s.id }"
          @click="$emit('select', s)"
        >
          <td class="name-cell">{{ s.name }}</td>
          <td><span class="badge badge-info">{{ typeLabel(s.type) }}</span></td>
          <td>{{ fmtDate(s.created_at) }}</td>
          <td>{{ s.last_backtest_at ? fmtDate(s.last_backtest_at) : '-' }}</td>
          <td>
            <span v-if="s.last_backtest_return != null"
              :class="s.last_backtest_return >= 0 ? 'badge badge-success' : 'badge badge-danger'">
              {{ s.last_backtest_return >= 0 ? '+' : '' }}{{ s.last_backtest_return?.toFixed(2) }}%
            </span>
            <span v-else>-</span>
          </td>
          <td @click.stop>
            <div class="actions">
              <!-- 运行中显示进度 -->
              <template v-if="runningId === s.id">
                <span class="running-hint">
                  <Loader2 :size="14" class="spin" />
                  {{ runPct }}%
                </span>
              </template>
              <template v-else>
                <button class="btn btn-ghost btn-sm" title="执行回测" @click="$emit('run', s)">
                  <Play :size="14" />
                </button>
              </template>
              <button class="btn btn-ghost btn-sm" title="查看结果"
                :disabled="!s.last_backtest_at"
                @click="$emit('result', s)">
                <BarChart2 :size="14" />
              </button>
              <button class="btn btn-danger btn-sm" title="删除" @click="$emit('delete', s)">
                <Trash2 :size="14" />
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { Plus, Play, BarChart2, Trash2, Loader2 } from 'lucide-vue-next'

defineProps({
  strategies: { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  runningId: { type: String, default: null },
  runPct: { type: Number, default: 0 },
  strategyTypes: { type: Array, default: () => [] },
})
defineEmits(['new', 'select', 'run', 'result', 'delete'])

function typeLabel(typeId) {
  const map = { ma_kdj: 'MA+KDJ' }
  return map[typeId] || typeId
}
function fmtDate(iso) {
  if (!iso) return '-'
  return iso.replace('T', ' ').slice(0, 16)
}
</script>

<style scoped>
.strategy-list { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.list-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}
.list-title { font-size: 1.1rem; }
.empty { padding: 48px 20px; text-align: center; color: var(--color-text-secondary); }
table { width: 100%; border-collapse: collapse; font-size: .88rem; overflow-y: auto; }
thead { position: sticky; top: 0; z-index: 1; }
th { background: #f4f6f8; padding: 10px 14px; text-align: left; font-weight: 600; color: #555; }
td { padding: 10px 14px; border-bottom: 1px solid var(--color-border-light); }
tr { cursor: pointer; }
tr:hover td { background: #f8fafc; }
tr.active td { background: #eaf4fd; }
.name-cell { font-weight: 500; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actions { display: flex; gap: 4px; }
.running-hint { display: flex; align-items: center; gap: 4px; color: var(--color-primary); font-size: .82rem; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
