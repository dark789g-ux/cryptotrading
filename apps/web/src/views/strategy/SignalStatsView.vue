<template>
  <div class="signal-stats-view">
    <!-- Left panel: test list -->
    <div class="test-list-panel">
      <div class="panel-header">
        <span class="panel-title">方案列表</span>
        <n-button size="small" type="primary" @click="handleNewTest">
          <template #icon><n-icon><add-icon /></n-icon></template>
          新建
        </n-button>
      </div>

      <n-spin :show="store.loading">
        <div class="test-list">
          <div
            v-for="test in store.tests"
            :key="test.id"
            class="test-item"
            :class="{ 'test-item--active': selectedTestId === test.id }"
            @click="selectTest(test.id)"
          >
            <div class="test-item-name">{{ test.name }}</div>
            <div class="test-item-meta">
              {{ test.dateStart.slice(0, 4) }}-{{ test.dateStart.slice(4, 6) }}-{{ test.dateStart.slice(6, 8) }}
              ~
              {{ test.dateEnd.slice(0, 4) }}-{{ test.dateEnd.slice(4, 6) }}-{{ test.dateEnd.slice(6, 8) }}
            </div>
          </div>

          <n-empty v-if="!store.loading && store.tests.length === 0" description="暂无方案" size="small" />
        </div>
      </n-spin>
    </div>

    <!-- Right panel: detail -->
    <div class="detail-panel">
      <template v-if="selectedTest">
        <div class="detail-header">
          <span class="detail-title">{{ selectedTest.name }}</span>
          <n-space>
            <n-button
              type="primary"
              :loading="store.runningId === selectedTestId"
              :disabled="store.runningId !== null"
              @click="handleRun"
            >
              {{ store.runningId === selectedTestId ? '运行中...' : '运行' }}
            </n-button>
            <n-button @click="handleEdit">编辑</n-button>
            <n-popconfirm @positive-click="handleDelete">
              <template #trigger>
                <n-button type="error">删除</n-button>
              </template>
              确定删除此方案？运行历史和明细将一并删除。
            </n-popconfirm>
          </n-space>
        </div>

        <!-- Run result & history -->
        <n-card :bordered="false" class="result-card">
          <SignalStatsResult :test-id="selectedTestId" />
        </n-card>
      </template>

      <div v-else class="detail-empty">
        <n-empty description="请从左侧选择或新建一个方案" />
      </div>
    </div>

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
        @submit="handleFormSubmit"
      />
      <template #actions>
        <n-button @click="showForm = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="handleFormSave">保存</n-button>
      </template>
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
  NButton,
  NIcon,
  NSpin,
  NEmpty,
  NSpace,
  NPopconfirm,
  NCard,
  useMessage,
} from 'naive-ui'
import { Add as AddIcon } from '@vicons/ionicons5'
import { useSignalStatsStore } from '../../stores/signalStats'
import type { SignalTest, CreateSignalTestDto } from '../../api/modules/strategy/signalStats'
import AppModal from '../../components/common/AppModal.vue'
import SignalTestForm from './SignalTestForm.vue'
import SignalStatsResult from './SignalStatsResult.vue'

const message = useMessage()
const store = useSignalStatsStore()

const selectedTestId = ref<string | null>(null)
const showForm = ref(false)
const editingTest = ref<SignalTest | null>(null)
const formRef = ref<InstanceType<typeof SignalTestForm> | null>(null)
const submitting = ref(false)

const selectedTest = computed<SignalTest | null>(() =>
  selectedTestId.value
    ? (store.tests.find((t) => t.id === selectedTestId.value) ?? null)
    : null,
)

function selectTest(id: string) {
  selectedTestId.value = id
  // Load runs for this test
  store.fetchRuns(id)
}

function handleNewTest() {
  editingTest.value = null
  showForm.value = true
}

function handleEdit() {
  if (!selectedTest.value) return
  editingTest.value = selectedTest.value
  showForm.value = true
}

async function handleDelete() {
  if (!selectedTestId.value) return
  try {
    await store.deleteTest(selectedTestId.value)
    selectedTestId.value = null
    message.success('删除成功')
  } catch {
    message.error('删除失败')
  }
}

async function handleRun() {
  if (!selectedTestId.value) return
  try {
    await store.startRun(selectedTestId.value)
  } catch {
    message.error('启动运行失败')
  }
}

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
      const created = await store.createTest(dto)
      message.success('创建成功')
      selectedTestId.value = created.id
    }
    showForm.value = false
    editingTest.value = null
  } catch {
    message.error(editingTest.value ? '更新失败' : '创建失败')
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  store.fetchTests()
})
</script>

<style scoped>
.signal-stats-view {
  display: flex;
  height: 100%;
  min-height: 0;
  padding: 16px;
  gap: 16px;
}

/* ── Left panel ─────────────────────────────────────────────────────────────── */
.test-list-panel {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--n-card-color, #fff);
  border: 1px solid var(--n-border-color, #e0e0e0);
  border-radius: 8px;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--n-border-color, #e0e0e0);
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
}

.test-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.test-item {
  padding: 10px 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.test-item:hover {
  background: var(--n-hover-color, #f5f5f5);
}

.test-item--active {
  background: color-mix(in srgb, var(--color-primary, #2080f0) 10%, transparent);
}

.test-item-name {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  word-break: break-all;
}

.test-item-meta {
  font-size: 11px;
  color: var(--n-text-color-3, #999);
  margin-top: 4px;
}

/* ── Right panel ────────────────────────────────────────────────────────────── */
.detail-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.detail-title {
  font-size: 18px;
  font-weight: 700;
}

.result-card {
  flex: 1;
}

.detail-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
