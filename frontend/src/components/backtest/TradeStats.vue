<template>
  <div class="stats-grid">
    <div class="stat-card" v-for="item in items" :key="item.label">
      <div class="stat-label">{{ item.label }}</div>
      <div class="stat-value" :class="item.cls">{{ item.value }}</div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({ stats: { type: Object, default: () => ({}) } })

const items = computed(() => {
  const s = props.stats
  const get = (key) => s[key] ?? '-'
  const pct = (v) => v != null ? v : '-'
  return [
    { label: '总收益率', value: get('总收益率'), cls: colorCls(s['总收益率']) },
    { label: '最终净值', value: get('最终净值') },
    { label: '最大回撤', value: get('最大回撤'), cls: 'danger' },
    { label: '夏普率(年化)', value: get('夏普率(年化)') },
    { label: '胜率', value: get('胜率(完整出场)') },
    { label: '完整交易次数', value: get('完整交易次数') },
    { label: '胜场平均收益率', value: get('胜场平均收益率'), cls: 'success' },
    { label: '败场平均收益率', value: get('败场平均收益率'), cls: 'danger' },
    { label: '平均持仓(h)', value: get('平均持仓周期(h)') },
    { label: '阶段止盈次数', value: get('阶段止盈次数') },
  ]
})

function colorCls(v) {
  if (!v) return ''
  const n = parseFloat(v)
  return isNaN(n) ? '' : n >= 0 ? 'success' : 'danger'
}
</script>

<style scoped>
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.stat-card {
  background: #f8fafc;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px 12px;
}
.stat-label { font-size: .75rem; color: var(--color-text-secondary); margin-bottom: 4px; }
.stat-value { font-size: 1rem; font-weight: 700; color: var(--color-text); }
.stat-value.success { color: var(--color-success); }
.stat-value.danger  { color: var(--color-danger); }
</style>
