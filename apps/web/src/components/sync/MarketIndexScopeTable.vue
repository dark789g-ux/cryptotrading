<template>
  <div class="market-index-scope-table">
    <div class="section-header">
      <span class="section-title">当前范围内（{{ rows.length }} 个）</span>
      <span class="section-hint">大盘同步读这份范围（catalog type='M'）</span>
    </div>
    <n-data-table
      data-testid="market-index-scope-table"
      :columns="columns"
      :data="rows"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      size="small"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, h, reactive } from 'vue'
import { NButton, NDataTable, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { marketIndexScopeApi, type MarketIndexScopeRow } from '@/api'

defineOptions({ name: 'MarketIndexScopeTable' })

defineProps<{
  rows: MarketIndexScopeRow[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'removed', tsCode: string): void
}>()

const message = useMessage()

// 响应式：记录正在移除的 ts_code，驱动按钮 loading。普通 Set 不触发重渲染。
const removingMap = reactive<Record<string, boolean>>({})

const columns = computed<DataTableColumns<MarketIndexScopeRow>>(() => [
  { title: '代码', key: 'ts_code', width: 130 },
  { title: '名称', key: 'name' },
  {
    title: '操作',
    key: 'actions',
    width: 120,
    render(row) {
      return h(
        NButton,
        {
          size: 'small',
          type: 'error',
          ghost: true,
          loading: removingMap[row.ts_code] === true,
          onClick: () => handleRemove(row),
        },
        { default: () => '移除' },
      )
    },
  },
])

async function handleRemove(row: MarketIndexScopeRow) {
  removingMap[row.ts_code] = true
  try {
    await marketIndexScopeApi.remove(row.ts_code)
    message.success(`已移除 ${row.ts_code}`)
    emit('removed', row.ts_code)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    removingMap[row.ts_code] = false
  }
}
</script>

<style scoped>
.market-index-scope-table {
  margin-top: 12px;
}
.section-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.section-title {
  font-weight: 600;
}
.section-hint {
  font-size: 12px;
  color: var(--n-text-color-3, #999);
}
</style>
