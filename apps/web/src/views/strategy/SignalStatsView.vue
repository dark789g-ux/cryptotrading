<template>
  <div class="signal-stats-view">
    <n-card title="信号前向统计" :bordered="false">
      <template #header-extra>
        <n-popover trigger="click" placement="bottom-end" :show="showImportPopover" @update:show="showImportPopover = $event">
          <template #trigger>
            <n-button :disabled="store.tests.length === 0" @click="showImportPopover = true">
              <template #icon><n-icon><download-icon /></n-icon></template>
              导入方案
            </n-button>
          </template>
          <n-select
            placeholder="选择已有方案..."
            :options="importOptions"
            style="width: 280px"
            filterable
            @update:value="onImportSelect"
          />
        </n-popover>
        <n-button type="primary" @click="handleNewTest">
          <template #icon><n-icon><add-icon /></n-icon></template>
          新建方案
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

      <SignalStatsTable
        :tests="store.tests"
        :loading="store.loading"
        @run="handleRun"
        @detail="handleDetail"
        @edit="handleEdit"
        @delete="handleDelete"
      />
    </n-card>

    <!-- Detail modal -->
    <AppModal
      v-model:show="showDetail"
      :title="selectedTest?.name ?? '方案详情'"
      width="min(1100px, 96vw)"
      maximizable
    >
      <SignalStatsResult v-if="selectedTest" :key="selectedTest.id" :test="selectedTest" />
    </AppModal>

    <!-- Create / Edit modal -->
    <AppModal
      v-model:show="showForm"
      :title="editingTest ? '编辑方案' : '新建方案'"
      :description="editingTest ? '修改信号前向统计方案配置' : '配置买入条件与出场规则，统计历史胜率与盈亏比'"
      width="min(860px, 96vw)"
      :mask-closable="false"
    >
      <SignalTestForm
        ref="formRef"
        :initial-data="editingTest ?? undefined"
        :prefill-data="importSource ?? undefined"
        @submit="handleFormSubmit"
      />
      <template #actions>
        <n-button @click="importSource = null; showForm = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="handleFormSave">保存</n-button>
      </template>
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { NAlert, NButton, NCard, NIcon, NPopover, NSelect, useMessage } from 'naive-ui'
import { Add as AddIcon, DownloadOutline as DownloadIcon } from '@vicons/ionicons5'
import { useSignalStatsStore } from '../../stores/signalStats'
import type {
  SignalTest,
  CreateSignalTestDto,
  SignalTestWithLatestRun,
} from '../../api/modules/strategy/signalStats'
import AppModal from '../../components/common/AppModal.vue'
import SignalTestForm from './SignalTestForm.vue'
import SignalStatsResult from './SignalStatsResult.vue'
import SignalStatsTable from './SignalStatsTable.vue'

const message = useMessage()
const store = useSignalStatsStore()

// ── Detail modal ────────────────────────────────────────────────────────────
const showDetail = ref(false)
const selectedTestId = ref<string | null>(null)
// Derive from store.tests so polling-patched latestRun stays reactive in the open detail.
const selectedTest = computed<SignalTestWithLatestRun | null>(
  () => store.tests.find((t) => t.id === selectedTestId.value) ?? null,
)

// ── Edit / create modal ─────────────────────────────────────────────────────
const showForm = ref(false)
const editingTest = ref<SignalTest | null>(null)
const formRef = ref<InstanceType<typeof SignalTestForm> | null>(null)
const submitting = ref(false)

// ── Import ────────────────────────────────────────────────────────────────────
const importSource = ref<SignalTest | null>(null)
const showImportPopover = ref(false)

function exitModeLabel(mode: string): string {
  const map: Record<string, string> = { fixed_n: '固定天数', strategy: '策略条件', trailing_lock: '移动止损' }
  return map[mode] ?? mode
}

const importOptions = computed(() =>
  store.tests.map((t) => ({
    label: `${t.name}（${exitModeLabel(t.exitMode)} / ${t.universe.type === 'all' ? '全市场' : '指定标的'}）`,
    value: t.id,
  }))
)

function onImportSelect(testId: string) {
  const test = store.tests.find((t) => t.id === testId)
  if (!test) return
  importSource.value = test
  editingTest.value = null
  showImportPopover.value = false
  showForm.value = true
}

// ── Table handlers ──────────────────────────────────────────────────────────
async function handleRun(id: string) {
  try {
    await store.startRun(id)
  } catch (e: unknown) {
    const err = e instanceof Error ? e : null
    message.error(err?.message ?? '启动运行失败')
  }
}

function handleDetail(test: SignalTestWithLatestRun) {
  if (!test.latestRun) {
    message.info('该方案尚未运行，请先点「运行」')
    return
  }
  selectedTestId.value = test.id
  showDetail.value = true
}

function handleEdit(test: SignalTestWithLatestRun) {
  editingTest.value = test
  showForm.value = true
}

async function handleDelete(id: string) {
  try {
    await store.deleteTest(id)
    if (selectedTestId.value === id) showDetail.value = false
    message.success('删除成功')
  } catch {
    message.error('删除失败')
  }
}

function handleNewTest() {
  editingTest.value = null
  importSource.value = null
  showForm.value = true
}

// ── Form submit ─────────────────────────────────────────────────────────────
function handleFormSave() {
  formRef.value?.submit()
}

async function handleFormSubmit(dto: CreateSignalTestDto) {
  submitting.value = true
  try {
    if (editingTest.value) {
      await store.updateTest(editingTest.value.id, dto)
      message.success('更新成功')
    } else {
      await store.createTest(dto)
      message.success('创建成功')
    }
    showForm.value = false
    editingTest.value = null
    importSource.value = null
  } catch {
    message.error(editingTest.value ? '更新失败' : '创建失败')
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await store.fetchTests()
  store.resumeAllPolling()   // fetchTests 后若有 running 就恢复轮询
})

onUnmounted(() => store.stopPolling())  // 离开页面清 timer 防泄漏
</script>

<style scoped>
.signal-stats-view {
  height: 100%;
  min-height: 0;
  padding: 16px;
  overflow-y: auto;
}
</style>
