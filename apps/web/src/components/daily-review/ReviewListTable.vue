<template>
  <n-data-table
    :columns="columns"
    :data="items"
    :pagination="pagination"
    remote
    @update:page="emit('page', $event)"
  />
</template>

<script setup lang="ts">
import { computed, h } from 'vue'
import { NDataTable, NTag, NButton, NSpace } from 'naive-ui'
import { useRouter } from 'vue-router'
import { useAuth } from '@/composables/hooks/useAuth'
import ReviewProgressBar from './ReviewProgressBar.vue'
import type { DailyReviewListItem } from '@/types/daily-review'

const props = defineProps<{
  items: DailyReviewListItem[]
  total: number
  page: number
  pageSize: number
}>()
const emit = defineEmits<{
  page: [page: number]
  regenerate: [tradeDate: string]
  remove: [tradeDate: string]
}>()

const router = useRouter()
const auth = useAuth()

const STATUS_MAP: Record<string, { label: string; type: 'success' | 'warning' | 'error' | 'info' }> = {
  pending:    { label: '待生成', type: 'info' },
  fetching:   { label: '采集中', type: 'warning' },
  generating: { label: '生成中', type: 'warning' },
  completed:  { label: '已完成', type: 'success' },
  failed:     { label: '失败',   type: 'error' },
}

const columns = computed(() => [
  { title: '交易日', key: 'tradeDate' },
  {
    title: '状态',
    key: 'status',
    render: (r: DailyReviewListItem) =>
      r.status === 'fetching' || r.status === 'generating'
        ? h(ReviewProgressBar, { tradeDate: r.tradeDate })
        : h(NTag, { type: STATUS_MAP[r.status]?.type ?? 'info' }, () => STATUS_MAP[r.status]?.label ?? r.status),
  },
  {
    title: '更新时间',
    key: 'updatedAt',
    render: (r: DailyReviewListItem) => new Date(r.updatedAt).toLocaleString(),
  },
  {
    title: '操作',
    key: 'actions',
    render: (r: DailyReviewListItem) =>
      h(NSpace, {}, () => [
        h(NButton, {
          size: 'small',
          onClick: () => router.push({ name: 'daily-review-detail', params: { tradeDate: r.tradeDate } }),
        }, () => '查看'),
        ...(auth.isAdmin.value ? [
          h(NButton, { size: 'small', onClick: () => emit('regenerate', r.tradeDate) }, () => '重生成'),
          h(NButton, { size: 'small', type: 'error', onClick: () => emit('remove', r.tradeDate) }, () => '删除'),
        ] : []),
      ]),
  },
])

const pagination = computed(() => ({
  page: props.page,
  pageSize: props.pageSize,
  itemCount: props.total,
  showSizePicker: false,
}))
</script>
