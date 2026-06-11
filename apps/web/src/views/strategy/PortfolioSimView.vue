<template>
  <div class="portfolio-sim-view">
    <n-card title="组合级模拟器" :bordered="false">
      <template #header-extra>
        <n-button type="primary" @click="showCreate = true">
          <template #icon><n-icon><add-icon /></n-icon></template>
          新建组合
        </n-button>
      </template>

      <n-alert
        v-if="store.lastPollError"
        type="warning"
        closable
        :bordered="false"
        style="margin-bottom: 12px"
        @close="store.lastPollError = null"
      >
        进度轮询出现问题：{{ store.lastPollError }}
      </n-alert>

      <PortfolioSimTable
        :runs="store.runs"
        :loading="store.loading"
        @run="handleRun"
        @detail="handleDetail"
        @delete="handleDelete"
      />
    </n-card>

    <!-- 详情 modal -->
    <AppModal
      v-model:show="showDetail"
      :title="selectedRun?.name ?? '组合详情'"
      width="min(1180px, 96vw)"
      maximizable
    >
      <PortfolioSimDetail v-if="selectedRun" :key="selectedRun.id" :run="selectedRun" />
    </AppModal>

    <!-- 新建 modal -->
    <PortfolioSimCreateModal v-model:show="showCreate" @created="onCreated" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { NAlert, NButton, NCard, NIcon, useMessage } from 'naive-ui'
import { Add as AddIcon } from '@vicons/ionicons5'
import { usePortfolioSimStore } from '../../stores/portfolioSim'
import type { PortfolioSimRun } from '../../api/modules/strategy/portfolioSim'
import AppModal from '../../components/common/AppModal.vue'
import PortfolioSimTable from '../../components/portfolio-sim/PortfolioSimTable.vue'
import PortfolioSimDetail from '../../components/portfolio-sim/PortfolioSimDetail.vue'
import PortfolioSimCreateModal from '../../components/portfolio-sim/PortfolioSimCreateModal.vue'

const message = useMessage()
const store = usePortfolioSimStore()

const showCreate = ref(false)
const showDetail = ref(false)
const selectedRunId = ref<string | null>(null)

// 从 store.runs 派生，让轮询补丁/详情刷新对已打开的详情保持响应
const selectedRun = computed<PortfolioSimRun | null>(
  () => store.runs.find((r) => r.id === selectedRunId.value) ?? null,
)

async function handleRun(id: string) {
  try {
    await store.startRun(id)
  } catch (e) {
    message.error(e instanceof Error ? e.message : '启动运行失败')
  }
}

async function handleDetail(run: PortfolioSimRun) {
  selectedRunId.value = run.id
  showDetail.value = true
  // 成功态补拉一次全量（含指标 / anchorCheck），列表项可能只有进度字段
  if (run.status === 'success' && run.finalNav == null) {
    try {
      await store.fetchOne(run.id)
    } catch {
      // 详情补拉失败不阻断弹窗，卡片显示 — 即可
    }
  }
}

async function handleDelete(id: string) {
  try {
    await store.deleteRun(id)
    if (selectedRunId.value === id) showDetail.value = false
    message.success('删除成功')
  } catch (e) {
    message.error(e instanceof Error ? e.message : '删除失败')
  }
}

function onCreated() {
  void store.fetchRuns()
}

onMounted(async () => {
  await store.fetchRuns()
  store.resumeAllPolling()
})

onUnmounted(() => store.stopPolling())
</script>

<style scoped>
.portfolio-sim-view {
  height: 100%;
  min-height: 0;
  padding: 16px;
  overflow-y: auto;
}
</style>
