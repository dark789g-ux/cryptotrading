<template>
  <n-data-table
    :columns="columns"
    :data="items"
    :loading="loading"
    :row-key="(row: FactorDefinition) => `${row.factor_id}:${row.factor_version}`"
    size="small"
    :bordered="false"
    :pagination="false"
  />
</template>

<script setup lang="ts">
import { computed, h, ref } from 'vue'
import {
  NButton,
  NPopconfirm,
  NDataTable,
  NSwitch,
  NTag,
  useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { quantApi, type FactorDefinition } from '@/api/modules/quant'

const props = defineProps<{
  items: FactorDefinition[]
  loading?: boolean
}>()

const emit = defineEmits<{
  /** 行内启停成功后透出最新行，父组件原地刷新 */
  updated: [item: FactorDefinition]
  /** 点击「编辑」按钮触发，父组件打开 modal */
  edit: [item: FactorDefinition]
}>()

const message = useMessage()

/** 正在 toggle 的因子 id:version，期间禁用其它操作避免连点 */
const togglingKeys = ref<Set<string>>(new Set())

function keyOf(row: FactorDefinition): string {
  return `${row.factor_id}:${row.factor_version}`
}

async function performToggle(row: FactorDefinition) {
  const key = keyOf(row)
  if (togglingKeys.value.has(key)) return
  const desiredEnabled = !row.enabled
  togglingKeys.value.add(key)
  try {
    const res = await quantApi.updateFactor(row.factor_id, row.factor_version, {
      enabled: desiredEnabled,
    })
    message.success(
      desiredEnabled
        ? `已启用 ${res.item.factor_id}`
        : `已禁用 ${res.item.factor_id}`,
    )
    emit('updated', res.item)
  } catch (e) {
    // 失败：UI 状态由父组件持有，未变更，无需手动回滚 switch
    message.error(`切换失败：${(e as Error).message}`)
  } finally {
    togglingKeys.value.delete(key)
  }
}

const columns = computed<DataTableColumns<FactorDefinition>>(() => [
  {
    title: '启用',
    key: 'enabled',
    width: 90,
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
              'data-testid': `factor-switch-${row.factor_id}`,
              // 阻止默认双向绑定 —— popconfirm 才真正触发；这里仅做 UI 显示
              'onUpdate:value': () => {
                /* no-op；实际切换走 popconfirm 的 positive */
              },
            }),
          default: () =>
            `确认 ${row.enabled ? '禁用' : '启用'} ${row.factor_id}？该变更下一次端到端训练生效`,
        },
      )
    },
  },
  {
    title: 'factor_id',
    key: 'factor_id',
    minWidth: 200,
    render(row) {
      return h('span', { class: 'mono' }, row.factor_id)
    },
  },
  {
    title: 'version',
    key: 'factor_version',
    width: 80,
    render(row) {
      return h('span', { class: 'mono' }, row.factor_version)
    },
  },
  {
    title: '描述',
    key: 'description',
    minWidth: 220,
    ellipsis: { tooltip: true },
  },
  {
    title: '类别',
    key: 'category',
    width: 110,
    render(row) {
      return h(
        NTag,
        { size: 'small', type: categoryTagType(row.category), bordered: false },
        { default: () => row.category },
      )
    },
  },
  {
    title: 'PIT 窗口',
    key: 'pit_window_days',
    width: 90,
    align: 'right',
  },
  {
    title: 'PIT 锚点',
    key: 'pit_anchor',
    width: 110,
    render(row) {
      return h('span', { class: 'mono' }, row.pit_anchor)
    },
  },
  {
    title: '顺序',
    key: 'display_order',
    width: 70,
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
          'data-testid': `factor-edit-btn-${row.factor_id}`,
          onClick: () => emit('edit', row),
        },
        { default: () => '编辑' },
      )
    },
  },
])

function categoryTagType(c: FactorDefinition['category']):
  | 'default'
  | 'info'
  | 'success'
  | 'warning' {
  switch (c) {
    case 'price':
      return 'info'
    case 'industry':
      return 'success'
    case 'fundamental':
      return 'warning'
    default:
      return 'default'
  }
}

// 静默 props 的"未使用变量"错误（props.loading 被 template 引用，props.items 同理）
void props
</script>

<style scoped>
:deep(.mono) {
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 12px;
}
</style>
