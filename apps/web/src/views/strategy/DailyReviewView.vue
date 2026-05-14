<template>
  <div class="page">
    <div class="page-header">
      <h2>每日复盘</h2>
      <ReviewCreateButton :existing-dates="existingDates" @created="onCreated" />
    </div>
    <ReviewListTable
      :items="data.items"
      :total="data.total"
      :page="data.page"
      :page-size="data.pageSize"
      @page="loadPage"
      @regenerate="onRegenerate"
      @remove="onRemove"
    />
  </div>
</template>

<script setup lang="ts">
import { onActivated, onMounted, reactive, computed } from 'vue'
import { useMessage } from 'naive-ui'
import ReviewCreateButton from '@/components/daily-review/ReviewCreateButton.vue'
import ReviewListTable from '@/components/daily-review/ReviewListTable.vue'
import { useDailyReviewApi } from '@/composables/useDailyReviewApi'
import type { DailyReviewListItem } from '@/types/daily-review'

const api = useDailyReviewApi()
const msg = useMessage()

const data = reactive<{
  items: DailyReviewListItem[]
  total: number
  page: number
  pageSize: number
}>({ items: [], total: 0, page: 1, pageSize: 20 })

const existingDates = computed(() => data.items.map(i => i.tradeDate))

async function loadPage(page = 1) {
  const r = await api.list({ page, pageSize: data.pageSize })
  Object.assign(data, r)
}

onMounted(() => loadPage())
onActivated(() => loadPage()) // CLAUDE.md keep-alive 规范

async function onCreated(tradeDate: string) {
  msg.success(`已开始生成 ${tradeDate}`)
  await loadPage(1)
}
async function onRegenerate(tradeDate: string) {
  await api.create(tradeDate)
  msg.success(`已开始重生成 ${tradeDate}`)
  await loadPage(data.page)
}
async function onRemove(tradeDate: string) {
  await api.remove(tradeDate)
  msg.success(`已删除 ${tradeDate}`)
  await loadPage(data.page)
}
</script>

<style scoped>
.page {
  padding: 16px 24px;
}
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
</style>
