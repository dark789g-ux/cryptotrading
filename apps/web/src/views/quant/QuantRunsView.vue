<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2>量化 · 训练 Run</h2>
        <p class="subtitle">所有训练 run 的 OOS 指标列表</p>
      </div>
      <div class="filters">
        <n-input
          v-model:value="versionFilter"
          placeholder="按 model_version 前缀过滤"
          clearable
          size="small"
          style="width: 280px"
          @update:value="onFilterChange"
        />
      </div>
    </div>

    <n-alert v-if="errorText" type="error" :title="errorText" closable style="margin-bottom: 12px;" />

    <n-card size="small" :bordered="false">
      <n-empty v-if="!loading && rows.length === 0" description="暂无训练 run（请先在量化作业页提交训练任务）" />
      <n-data-table
        v-else
        :columns="columns"
        :data="rows"
        :loading="loading"
        :pagination="pagination"
        :remote="true"
        size="small"
        :bordered="false"
        :row-key="(row: ModelRunListItem) => row.id"
        :row-props="rowProps"
        @update:page="onPageChange"
        @update:sorter="onSortChange"
      />
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onActivated, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert, NCard, NDataTable, NEmpty, NInput, useDialog,
} from 'naive-ui'
import type { DataTableColumns, DataTableSortState, PaginationProps } from 'naive-ui'
import MetricBadge from '@/components/quant/MetricBadge.vue'
import { quantApi, type ModelRunListItem, type RunsQuery } from '@/api/modules/quant'

const router = useRouter()
const dialog = useDialog()

const rows = ref<ModelRunListItem[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)
const errorText = ref('')

const versionFilter = ref('')
/**
 * J 仅允许 sort_by 字段 ∈ {created_at, model_version}（违反 400）；
 * 指标列（NDCG@10 / IC / 扣成本年化）不参与远端排序，前端 column 渲染时
 * 不再挂 sorter，避免 NDataTable 触发 sortChange 后被后端拒绝。
 */
const sortField = ref<RunsQuery['sortField']>('created_at')
const sortOrder = ref<'ASC' | 'DESC'>('DESC')

function fmtMetric(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

function getSortOrder(field: string): 'ascend' | 'descend' | false {
  if (sortField.value !== field) return false
  return sortOrder.value === 'ASC' ? 'ascend' : 'descend'
}

function fmtTime(s: string): string {
  if (!s) return ''
  // J 的 formatUtcWallClock 输出形如 '2026-05-17 10:30:00Z'，直接展示即可
  return s
}

const columns = computed<DataTableColumns<ModelRunListItem>>(() => [
  {
    title: '模型版本',
    key: 'model_version',
    minWidth: 280,
    sorter: 'default' as const,
    sortOrder: getSortOrder('model_version'),
    render(row) {
      return h('span', { class: 'mono' }, row.model_version)
    },
  },
  {
    title: '创建时间',
    key: 'created_at',
    width: 200,
    sorter: 'default' as const,
    sortOrder: getSortOrder('created_at'),
    render: row => fmtTime(row.created_at),
  },
  {
    title: 'NDCG@10',
    key: 'ndcg_at_10',
    width: 130,
    align: 'right',
    render(row) {
      return h(MetricBadge, {
        label: '',
        value: fmtMetric(row.oos_metrics_core?.ndcg_at_10),
        digits: 4,
        thresholds: { good: 0.55, warn: 0.5 },
      })
    },
  },
  {
    title: 'IC',
    key: 'ic',
    width: 110,
    align: 'right',
    render(row) {
      return h(MetricBadge, {
        label: '',
        value: fmtMetric(row.oos_metrics_core?.ic),
        digits: 4,
        thresholds: { good: 0.05, warn: 0.02 },
      })
    },
  },
  {
    title: '扣成本年化',
    key: 'portfolio_annual_after_cost',
    width: 150,
    align: 'right',
    render(row) {
      return h(MetricBadge, {
        label: '',
        value: fmtMetric(row.oos_metrics_core?.portfolio_annual_after_cost),
        percent: true,
        digits: 2,
        thresholds: { good: 0.15, warn: 0 },
      })
    },
  },
  {
    title: 'feature_set_id',
    key: 'feature_set_id',
    minWidth: 200,
    ellipsis: { tooltip: true },
  },
  {
    title: '状态',
    key: 'status',
    width: 80,
    render(row) {
      // list 端点不返回 hyperparams / 完整 oos_metrics；用 oos_metrics_core 任一指标非空近似"已评估"
      const c = row.oos_metrics_core
      const ok = !!c && (
        c.ndcg_at_10 !== null
        || c.ic !== null
        || c.rank_ic !== null
        || c.portfolio_annual_after_cost !== null
      )
      return h(
        'span',
        { class: ok ? 'badge-ok' : 'badge-warn' },
        ok ? '已评估' : '待评估',
      )
    },
  },
])

const pagination = computed<PaginationProps>(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: total.value,
  showSizePicker: false,
}))

const rowProps = (row: ModelRunListItem) => ({
  style: 'cursor: pointer;',
  onClick: () => {
    // M4 才落详情页（路由 /quant/runs/:id 已预留但暂未注册组件）；
    // 当前给占位 dialog，并保留 router.push 注释便于 M4 直接接入。
    dialog.info({
      title: 'Run 详情（M4 落地）',
      content: `model_version: ${row.model_version}\nid: ${row.id}\n详情页 / SHAP / 模型下载将在 M4 实现。`,
      positiveText: '知道了',
    })
    // M4 取消下行注释：router.push({ name: 'quant-run-detail', params: { id: row.id } })
    void router.currentRoute.value
  },
})

async function loadRuns() {
  loading.value = true
  errorText.value = ''
  try {
    const res = await quantApi.listRuns({
      page: page.value,
      pageSize: pageSize.value,
      model_version: versionFilter.value || undefined,
      sortField: sortField.value,
      sortOrder: sortOrder.value,
    })
    rows.value = res.rows ?? []
    total.value = res.total ?? 0
  } catch (e) {
    errorText.value = `加载训练 run 列表失败：${(e as Error).message}`
    rows.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function onFilterChange(v: string) {
  versionFilter.value = v
  page.value = 1
  loadRuns()
}

function onPageChange(p: number) {
  page.value = p
  loadRuns()
}

/** J 仅允许 sort_by ∈ {created_at, model_version}（违反 400）；不在白名单的列触发时回退默认。 */
const ALLOWED_SORT_FIELDS: ReadonlyArray<NonNullable<RunsQuery['sortField']>> = [
  'created_at',
  'model_version',
]

function onSortChange(sort: DataTableSortState | null) {
  if (!sort || !sort.order) {
    sortField.value = 'created_at'
    sortOrder.value = 'DESC'
  } else {
    const key = String(sort.columnKey)
    if (ALLOWED_SORT_FIELDS.includes(key as NonNullable<RunsQuery['sortField']>)) {
      sortField.value = key as RunsQuery['sortField']
      sortOrder.value = sort.order === 'ascend' ? 'ASC' : 'DESC'
    } else {
      // 不应触发：指标列已移除 sorter；保留兜底回退
      sortField.value = 'created_at'
      sortOrder.value = 'DESC'
    }
  }
  loadRuns()
}

onMounted(loadRuns)
onActivated(loadRuns) // CLAUDE.md keep-alive 规范
</script>

<style scoped>
.page {
  padding: 16px 24px;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.subtitle {
  color: var(--color-text-muted);
  font-size: 13px;
  margin: 4px 0 0;
}
.filters {
  display: flex;
  gap: 12px;
  align-items: center;
}
:deep(.mono) {
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 12px;
}
:deep(.badge-ok) {
  color: var(--color-success);
  font-weight: 600;
  font-size: 12px;
}
:deep(.badge-warn) {
  color: var(--color-warning);
  font-weight: 600;
  font-size: 12px;
}
</style>
