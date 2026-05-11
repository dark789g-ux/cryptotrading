<template>
  <div class="page">
    <div class="page-header">
      <n-button text @click="router.push({ name: 'daily-review' })">← 返回列表</n-button>
      <span class="title">{{ tradeDate }} 复盘</span>
      <n-dropdown trigger="click" :options="menuOptions" @select="onMenu">
        <n-button>操作</n-button>
      </n-dropdown>
    </div>

    <template v-if="row?.status === 'fetching' || row?.status === 'generating'">
      <n-alert type="info" style="margin-bottom: 16px;">复盘正在生成，请稍候</n-alert>
      <ReviewProgressBar :trade-date="tradeDate" />
    </template>
    <template v-else-if="row?.status === 'failed'">
      <n-alert type="error" :title="'生成失败'" style="margin-bottom: 16px;">
        {{ row.errorMessage }}
      </n-alert>
      <n-button v-if="auth.isAdmin.value" @click="regenerate">重试</n-button>
    </template>
    <template v-else-if="row?.snapshot">
      <ReviewSnapshotCards :snapshot="row.snapshot" />
      <h3>行业资金流向 TOP10</h3>
      <ReviewIndustryChart :items="row.snapshot.industryRank" />
      <h3 style="margin-top: 24px;">主力资金净流入 / 净流出 TOP10</h3>
      <ReviewMoneyFlowChart
        :top-in="row.snapshot.moneyFlow.stocksTopIn.slice(0, 10)"
        :top-out="row.snapshot.moneyFlow.stocksTopOut.slice(0, 10)"
      />
      <n-collapse v-if="auth.isAdmin.value && row.reasoningContent" style="margin-top: 24px;">
        <n-collapse-item title="查看 AI 推理过程" name="reasoning">
          <pre class="reasoning">{{ row.reasoningContent }}</pre>
        </n-collapse-item>
      </n-collapse>
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
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCollapse, NCollapseItem, NDropdown, NEmpty, useMessage } from 'naive-ui'
import ReviewSnapshotCards from '@/components/daily-review/ReviewSnapshotCards.vue'
import ReviewIndustryChart from '@/components/daily-review/ReviewIndustryChart.vue'
import ReviewMoneyFlowChart from '@/components/daily-review/ReviewMoneyFlowChart.vue'
import ReviewArticleViewer from '@/components/daily-review/ReviewArticleViewer.vue'
import ReviewProgressBar from '@/components/daily-review/ReviewProgressBar.vue'
import { useAuth } from '@/composables/hooks/useAuth'
import { useDailyReviewApi } from '@/composables/useDailyReviewApi'

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const api = useDailyReviewApi()
const msg = useMessage()
const tradeDate = route.params.tradeDate as string
const row = ref<any>(null)

async function load() { row.value = await api.detail(tradeDate) }
onMounted(load)

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
.reasoning { white-space: pre-wrap; font-family: monospace; font-size: 12px; max-height: 400px; overflow: auto; }
</style>
