<template>
  <div class="page">
    <div class="page-header">
      <n-button text @click="router.push({ name: 'daily-review' })">← 返回列表</n-button>
      <span class="title">{{ tradeDate }} 复盘</span>
      <n-dropdown trigger="click" :options="menuOptions" @select="onMenu">
        <n-button>操作</n-button>
      </n-dropdown>
    </div>

    <!-- 生成中：实时思考面板 -->
    <template v-if="row?.status === 'fetching' || row?.status === 'generating'">
      <ReviewThinkingPanel
        :trade-date="tradeDate"
        mode="live"
        @completed="onSseCompleted"
        @failed="onSseFailed"
      />
      <!-- 60s 回收窗口后异常 fallback：SSE 没消息但 row 仍是 generating -->
      <n-alert v-if="staleHint" type="warning" style="margin-top: 12px;">
        生成状态未知，请刷新页面查看最新状态
      </n-alert>
    </template>

    <!-- 失败：错误提示 + 重试 + 思考过程回看（admin 可看 reasoning 残段） -->
    <template v-else-if="row?.status === 'failed'">
      <n-alert type="error" :title="'生成失败'" style="margin-bottom: 16px;">
        {{ row.errorMessage }}
      </n-alert>
      <n-button v-if="auth.isAdmin.value" @click="regenerate">重试</n-button>
      <ReviewThinkingPanel
        v-if="hasReplayData"
        :trade-date="tradeDate"
        mode="replay"
        :replay-data="replayData"
      />
    </template>

    <!-- 已完成：快照 + 思考过程回看 + 正文 -->
    <template v-else-if="row?.snapshot">
      <ReviewSnapshotCards :snapshot="row.snapshot" />
      <h3>行业资金流向 TOP10</h3>
      <ReviewIndustryChart :items="row.snapshot.industryRank" />
      <h3 style="margin-top: 24px;">主力资金净流入 / 净流出 TOP10</h3>
      <ReviewMoneyFlowChart
        :top-in="row.snapshot.moneyFlow.stocksTopIn.slice(0, 10)"
        :top-out="row.snapshot.moneyFlow.stocksTopOut.slice(0, 10)"
      />
      <ReviewThinkingPanel
        :trade-date="tradeDate"
        mode="replay"
        :replay-data="replayData"
      />
      <div style="margin-top: 32px;">
        <ReviewArticleViewer v-if="row.articleMd" :md="row.articleMd" />
      </div>
    </template>

    <template v-else>
      <n-empty description="暂无数据" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NDropdown, NEmpty, useMessage } from 'naive-ui'
import ReviewSnapshotCards from '@/components/daily-review/ReviewSnapshotCards.vue'
import ReviewIndustryChart from '@/components/daily-review/ReviewIndustryChart.vue'
import ReviewMoneyFlowChart from '@/components/daily-review/ReviewMoneyFlowChart.vue'
import ReviewArticleViewer from '@/components/daily-review/ReviewArticleViewer.vue'
import ReviewThinkingPanel from '@/components/daily-review/ReviewThinkingPanel.vue'
import { useAuth } from '@/composables/hooks/useAuth'
import { useDailyReviewApi } from '@/composables/useDailyReviewApi'

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const api = useDailyReviewApi()
const msg = useMessage()
const tradeDate = route.params.tradeDate as string
const row = ref<any>(null)

// SSE 60s 回收窗口外的异常态提示（生成中但收不到事件）
const staleHint = ref(false)
let staleTimer: ReturnType<typeof setTimeout> | null = null

async function load() {
  row.value = await api.detail(tradeDate)
  // 进 generating/fetching 状态时，60s 后若仍未切换则显示提示
  if (row.value?.status === 'fetching' || row.value?.status === 'generating') {
    if (staleTimer) clearTimeout(staleTimer)
    // SSE 完成回收窗口为 60s，给 90s 缓冲再提示
    staleTimer = setTimeout(() => {
      if (row.value?.status === 'fetching' || row.value?.status === 'generating') {
        staleHint.value = true
      }
    }, 90_000)
  } else {
    staleHint.value = false
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
  }
}
onMounted(load)
onUnmounted(() => { if (staleTimer) clearTimeout(staleTimer) })

// SSE 完成 → 重新拉详情，让 panel 切到 replay 模式
async function onSseCompleted() {
  await load()
}
async function onSseFailed(_err: string) {
  await load()
}

// replay 数据：从 row 投射；非 admin 字段后端已 strip 为 null
const replayData = computed(() => {
  if (!row.value) return null
  return {
    reasoningContent: row.value.reasoningContent ?? null,
    articleMd: row.value.articleMd ?? null,
    stageTimings: row.value.stageTimings ?? null,
    tokenUsage: row.value.tokenUsage ?? null,
    llmModel: row.value.llmModel ?? null,
    status: row.value.status,
    errorMessage: row.value.errorMessage ?? null,
  }
})

// 失败态时只有有任意 replay 字段才挂面板（避免空面板）
const hasReplayData = computed(() => {
  const d = replayData.value
  if (!d) return false
  return !!(d.reasoningContent || d.stageTimings?.length || d.tokenUsage || d.llmModel)
})

async function regenerate() {
  await api.create(tradeDate); msg.success('已重新触发'); await load()
}
async function remove() {
  await api.remove(tradeDate); msg.success('已删除'); router.push({ name: 'daily-review' })
}
function copyMd() {
  navigator.clipboard.writeText(row.value.articleMd); msg.success('已复制 Markdown')
}
function downloadMd() {
  const blob = new Blob([row.value.articleMd], { type: 'text/markdown' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = `${tradeDate}.md`; a.click()
}

const menuOptions = computed(() => [
  { label: '复制 Markdown', key: 'copy' },
  { label: '下载 .md',      key: 'download' },
  ...(auth.isAdmin.value ? [
    { label: '重新生成', key: 'regen' },
    { label: '删除',     key: 'remove' },
  ] : []),
])
function onMenu(key: string) {
  if (key === 'copy') copyMd()
  if (key === 'download') downloadMd()
  if (key === 'regen') regenerate()
  if (key === 'remove') remove()
}
</script>

<style scoped>
.page { padding: 16px 24px; }
.page-header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.title { font-size: 18px; font-weight: 600; margin-right: auto; }
</style>
