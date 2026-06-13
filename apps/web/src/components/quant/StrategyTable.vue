<template>
  <n-data-table
    :columns="columns"
    :data="items"
    :loading="loading"
    :row-key="(row: StrategyDefinition) => `${row.strategy_id}:${row.strategy_version}`"
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
import { quantApi } from '@/api/modules/quant'
import type { ExitRuleDef, StrategyDefinition } from '@cryptotrading/shared-types'

const props = defineProps<{
  items: StrategyDefinition[]
  loading?: boolean
}>()

const emit = defineEmits<{
  updated: [item: StrategyDefinition]
  edit: [item: StrategyDefinition]
}>()

const message = useMessage()

const togglingKeys = ref<Set<string>>(new Set())

function keyOf(row: StrategyDefinition): string {
  return `${row.strategy_id}:${row.strategy_version}`
}

async function performToggle(row: StrategyDefinition) {
  const key = keyOf(row)
  if (togglingKeys.value.has(key)) return
  const desiredEnabled = !row.enabled
  togglingKeys.value.add(key)
  try {
    const res = await quantApi.updateStrategy(row.strategy_id, row.strategy_version, {
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

/** 单条规则摘要：max_hold·days20 / stop_loss·pct0.08 */
function ruleSummary(r: ExitRuleDef): string {
  const entries = Object.entries(r.params)
  if (entries.length === 0) return r.type
  const [name, val] = entries[0]
  return `${r.type}·${name}${val}`
}

const columns = computed<DataTableColumns<StrategyDefinition>>(() => [
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
              'data-testid': `strategy-switch-${row.strategy_id}`,
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
    key: 'strategy_id',
    minWidth: 160,
    ellipsis: { lineClamp: 3, tooltip: true },
    render(row) {
      return h('span', { class: 'mono' }, `${row.strategy_id} (${row.strategy_version})`)
    },
  },
  {
    title: '出场规则（按顺序）',
    key: 'exit_rules',
    minWidth: 300,
    render(row) {
      const rules = row.exit_rules ?? []
      if (rules.length === 0) {
        return h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => '（无规则）' })
      }
      return h(
        'div',
        { class: 'rule-tags' },
        rules.map((r, i) =>
          h(
            NTag,
            {
              size: 'small',
              type: r.type === 'max_hold' ? 'success' : 'info',
              bordered: false,
              style: 'margin: 1px 4px 1px 0;',
            },
            { default: () => `${i + 1}. ${ruleSummary(r)}` },
          ),
        ),
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
          'data-testid': `strategy-edit-btn-${row.strategy_id}`,
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
.rule-tags {
  display: flex;
  flex-wrap: wrap;
}
</style>
