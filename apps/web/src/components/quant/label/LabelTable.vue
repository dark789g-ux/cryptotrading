<template>
  <n-data-table
    :columns="columns"
    :data="items"
    :loading="loading"
    :row-key="(row: LabelDefinition) => `${row.label_id}:${row.label_version}`"
    size="small"
    :bordered="false"
    :pagination="false"
  />
</template>

<script setup lang="ts">
import { computed, h, ref } from 'vue'
import {
  NButton, NDataTable, NPopconfirm, NSwitch, NTag,
  useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { quantApi, type LabelDefinition } from '@/api/modules/quant'

const props = defineProps<{
  items: LabelDefinition[]
  loading?: boolean
}>()

const emit = defineEmits<{
  updated: [item: LabelDefinition]
  edit: [item: LabelDefinition]
}>()

const message = useMessage()

const togglingKeys = ref<Set<string>>(new Set())

function keyOf(row: LabelDefinition): string {
  return `${row.label_id}:${row.label_version}`
}

async function performToggle(row: LabelDefinition) {
  const key = keyOf(row)
  if (togglingKeys.value.has(key)) return
  const desiredEnabled = !row.enabled
  togglingKeys.value.add(key)
  try {
    const res = await quantApi.updateLabel(row.label_id, row.label_version, {
      enabled: desiredEnabled,
    })
    message.success(desiredEnabled ? `已启用 ${res.item.name}` : `已禁用 ${res.item.name}`)
    emit('updated', res.item)
  } catch (e) {
    message.error(`切换失败：${(e as Error).message}`)
  } finally {
    togglingKeys.value.delete(key)
  }
}

/** 基础层摘要：fwd_ret h1 / strategy_aware */
function baseTypeSummary(row: LabelDefinition): string {
  if (row.base_type === 'fwd_ret') {
    const h = row.base_params?.horizon ?? '?'
    return `fwd_ret h${h}`
  }
  if (row.base_type === 'strategy_aware') {
    const id = row.base_params?.strategy_id
    const ver = row.base_params?.strategy_version
    return typeof id === 'string' && typeof ver === 'string'
      ? `strategy_aware ${id}@${ver}`
      : 'strategy_aware'
  }
  return row.base_type
}

/** 分类层摘要：band 0.5% / tercile / custom / — */
function classifySummary(row: LabelDefinition): string {
  const m = row.classify_mode
  if (!m) return '—（连续）'
  if (m === 'band') {
    const eps = row.classify_params?.eps
    return typeof eps === 'number' ? `band ${(eps * 100).toFixed(2)}%` : 'band'
  }
  if (m === 'tercile') return 'tercile'
  if (m === 'custom') {
    const lo = row.classify_params?.lo_pct ?? '?'
    const hi = row.classify_params?.hi_pct ?? '?'
    return `custom p${lo}-p${hi}`
  }
  return m
}

const columns = computed<DataTableColumns<LabelDefinition>>(() => [
  {
    title: '启用',
    key: 'enabled',
    width: 80,
    render(row) {
      const key = keyOf(row)
      return h(
        NPopconfirm,
        {
          onPositiveClick: () => performToggle(row),
          positiveText: '确认',
          negativeText: '取消',
        },
        {
          trigger: () =>
            h(NSwitch, {
              value: row.enabled,
              loading: togglingKeys.value.has(key),
              size: 'small',
              'data-testid': `label-switch-${row.label_id}`,
              'onUpdate:value': () => { /* no-op，popconfirm 才触发 */ },
            }),
          default: () =>
            `确认 ${row.enabled ? '禁用' : '启用'} ${row.name}？`,
        },
      )
    },
  },
  {
    title: '名称',
    key: 'name',
    minWidth: 160,
    ellipsis: { tooltip: true },
  },
  {
    title: 'ID / 版本',
    key: 'label_id',
    minWidth: 140,
    render(row) {
      return h('span', { class: 'mono' }, `${row.label_id} (${row.label_version})`)
    },
  },
  {
    title: '基础层',
    key: 'base_type',
    width: 160,
    render(row) {
      return h(
        NTag,
        { size: 'small', type: 'info', bordered: false },
        { default: () => baseTypeSummary(row) },
      )
    },
  },
  {
    title: '分类层',
    key: 'classify_mode',
    width: 160,
    render(row) {
      const cls = classifySummary(row)
      const type = row.classify_mode ? 'success' : 'default'
      return h(
        NTag,
        { size: 'small', type, bordered: false },
        { default: () => cls },
      )
    },
  },
  {
    title: '顺序',
    key: 'display_order',
    width: 60,
    align: 'right',
  },
  {
    title: '操作',
    key: 'actions',
    width: 80,
    render(row) {
      return h(
        NButton,
        {
          size: 'tiny',
          type: 'primary',
          ghost: true,
          'data-testid': `label-edit-btn-${row.label_id}`,
          onClick: () => emit('edit', row),
        },
        { default: () => '编辑' },
      )
    },
  },
])

// 静默 props 的"未使用变量"编译警告（props.loading / props.items 由 template 引用）
void props
</script>

<style scoped>
:deep(.mono) {
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 12px;
}
</style>
