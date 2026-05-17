<template>
  <n-card title="超参数" size="small" :bordered="false">
    <template #header-extra>
      <n-button text size="tiny" @click="copy">复制 JSON</n-button>
    </template>
    <n-empty v-if="entries.length === 0" description="该 run 未记录超参" />
    <table v-else class="hp-table">
      <thead>
        <tr><th>键</th><th>值</th></tr>
      </thead>
      <tbody>
        <tr v-for="[k, v] in entries" :key="k">
          <td class="key mono">{{ k }}</td>
          <td class="val mono">{{ display(v) }}</td>
        </tr>
      </tbody>
    </table>
  </n-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NCard, NEmpty, useMessage } from 'naive-ui'

const props = defineProps<{ hyperparams: Record<string, unknown> }>()
const msg = useMessage()

const entries = computed<Array<[string, unknown]>>(() => {
  if (!props.hyperparams || typeof props.hyperparams !== 'object') return []
  return Object.entries(props.hyperparams)
})

function display(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6)
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  try { return JSON.stringify(v) } catch { return String(v) }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(props.hyperparams, null, 2))
    msg.success('已复制超参 JSON')
  } catch {
    msg.warning('复制失败')
  }
}
</script>

<style scoped>
.hp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.hp-table th, .hp-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--color-border);
}
.hp-table th {
  color: var(--color-text-muted);
  font-weight: 500;
}
.key { width: 40%; color: var(--color-text-secondary); }
.val { color: var(--color-text); word-break: break-all; }
.mono { font-family: 'Menlo', 'Consolas', monospace; }
</style>
