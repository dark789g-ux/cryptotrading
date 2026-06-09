<template>
  <div class="group-panel">
    <KellyParetoScatter
      :points="scatterPoints"
      :loading="scatterLoading"
      :error="null"
    />
    <div style="margin-top: 16px" />
    <KellySweepTopkTable
      :rows="localRows"
      :total="localTotal"
      :page="page"
      :page-size="pageSize"
      :loading="localLoading"
      @page-change="onPageChange"
      @sort-change="onSortChange"
      @detail="(row) => emit('detail', row)"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * KellyGroupPanel
 *
 * 单口径组（with_rs 或 no_rs）面板：
 * - 帕累托散点（散点数据由父传入，与 topk 分离加载）
 * - top-K 排行表（本组件自持分页/排序状态，翻页/排序时自行调 getTopk）
 */
import { ref, watch } from 'vue'
import KellyParetoScatter from './KellyParetoScatter.vue'
import KellySweepTopkTable from './KellySweepTopkTable.vue'
import { kellySweepApi, type KellyScatterPoint, type KellyTopkRow, type SweepGroup } from '@/api/modules/quant/kellySweep'

const props = defineProps<{
  group: SweepGroup
  jobId: string | null
  scatterPoints: KellyScatterPoint[]
  scatterLoading?: boolean
  /** 初始 topk 行（由父首次加载传入，之后本组件自管） */
  initialTopkRows?: KellyTopkRow[]
  initialTopkTotal?: number
}>()

const emit = defineEmits<{
  detail: [row: KellyTopkRow]
}>()

// ---------- 本地 topk 状态（本组件自持，翻页/排序时重取）----------
const localRows = ref<KellyTopkRow[]>(props.initialTopkRows ?? [])
const localTotal = ref(props.initialTopkTotal ?? 0)
const localLoading = ref(false)

// ---------- 分页/排序状态 ----------
const page = ref(1)
const pageSize = ref(50)
const currentSort = ref<string | undefined>(undefined)

/** 监听父传入的初始数据（首次加载/历史 job 切换时同步） */
watch(
  () => [props.initialTopkRows, props.initialTopkTotal] as const,
  ([rows, total]) => {
    localRows.value = rows ?? []
    localTotal.value = total ?? 0
    // 重置分页/排序到初始状态
    page.value = 1
    currentSort.value = undefined
  },
)

/** 真正调接口重取 topk */
async function fetchTopk(p: number, sort?: string) {
  if (!props.jobId) return
  localLoading.value = true
  try {
    const res = await kellySweepApi.getTopk(props.jobId, {
      group: props.group,
      page: p,
      pageSize: pageSize.value,
      sort,
    })
    localRows.value = res.rows
    localTotal.value = res.total
  } catch (e) {
    console.warn(`[KellyGroupPanel] getTopk failed (group=${props.group})`, e)
  } finally {
    localLoading.value = false
  }
}

function onPageChange(p: number) {
  page.value = p
  fetchTopk(p, currentSort.value)
}

function onSortChange(sort: string) {
  currentSort.value = sort
  page.value = 1
  fetchTopk(1, sort)
}
</script>

<style scoped>
.group-panel {
  padding: 8px 0;
}
</style>
