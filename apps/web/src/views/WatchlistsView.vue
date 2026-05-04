<template>
  <div class="watchlists-view workspace-page">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">自选列表</h1>
    </div>

    <n-card class="watchlist-card" :bordered="false">
      <n-tabs
        v-if="store.watchlists.length > 0"
        v-model:value="store.currentId"
        type="card"
        closable
        @update:value="handleTabChange"
        @close="handleTabClose"
      >
        <n-tab-pane
          v-for="wl in store.watchlists"
          :key="wl.id"
          :name="wl.id"
          :display-directive="'show:lazy'"
        >
          <template #tab>
            <span
              @contextmenu.prevent="showTabContextMenu($event, wl)"
              class="tab-label"
            >
              {{ wl.name }}
            </span>
          </template>
          <watchlist-table />
        </n-tab-pane>

        <!-- 新建列表按钮 -->
        <template #suffix>
          <n-button text size="small" @click="openCreateModal">
            <template #icon>
              <n-icon><add-outline /></n-icon>
            </template>
          </n-button>
        </template>
      </n-tabs>

      <n-empty v-else description="暂无自选列表" style="padding: 80px 0">
        <template #extra>
          <n-button type="primary" @click="openCreateModal">
            <template #icon><n-icon><add-outline /></n-icon></template>
            新建列表
          </n-button>
        </template>
      </n-empty>
    </n-card>

    <!-- 新建/重命名弹窗 -->
    <n-modal v-model:show="showFormModal" :title="editTarget ? '重命名列表' : '新建列表'" preset="dialog">
      <n-input v-model:value="formName" placeholder="列表名称" @keyup.enter="submitForm" />
      <template #action>
        <n-button @click="showFormModal = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submitForm">保存</n-button>
      </template>
    </n-modal>

    <!-- 右键菜单 -->
    <n-dropdown
      :show="dropdownVisible"
      :options="dropdownOptions"
      :x="dropdownX"
      :y="dropdownY"
      trigger="manual"
      @clickoutside="dropdownVisible = false"
      @select="handleDropdownSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  NButton, NCard, NDropdown, NEmpty, NIcon, NInput, NModal, NTabs, NTabPane,
  useMessage, useDialog,
} from 'naive-ui'
import { AddOutline } from '@vicons/ionicons5'
import { useWatchlistStore } from '@/stores/watchlist'
import { watchlistApi, type Watchlist } from '@/api'
import WatchlistTable from '@/components/watchlist/WatchlistTable.vue'

const store = useWatchlistStore()
const message = useMessage()
const dialog = useDialog()

// 表单状态
const showFormModal = ref(false)
const submitting = ref(false)
const editTarget = ref<Watchlist | null>(null)
const formName = ref('')

// 右键菜单状态
const dropdownVisible = ref(false)
const dropdownX = ref(0)
const dropdownY = ref(0)
const contextMenuTarget = ref<Watchlist | null>(null)

const dropdownOptions = [
  { label: '重命名', key: 'rename' },
  { label: '删除', key: 'delete' },
]

function handleTabChange(id: string) {
  store.setCurrentId(id)
}

function handleTabClose(id: string) {
  const wl = store.watchlists.find((w) => w.id === id)
  if (!wl) return

  dialog.warning({
    title: '确认删除',
    content: `确定要删除列表 "${wl.name}" 吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await watchlistApi.delete(id)
      message.success('删除成功')
      store.loadWatchlists()
    },
  })
}

function showTabContextMenu(e: MouseEvent, wl: Watchlist) {
  contextMenuTarget.value = wl
  dropdownX.value = e.clientX
  dropdownY.value = e.clientY
  dropdownVisible.value = true
}

function handleDropdownSelect(key: string) {
  dropdownVisible.value = false
  const wl = contextMenuTarget.value
  if (!wl) return

  if (key === 'rename') {
    editTarget.value = wl
    formName.value = wl.name
    showFormModal.value = true
  } else if (key === 'delete') {
    handleTabClose(wl.id)
  }
}

function openCreateModal() {
  editTarget.value = null
  formName.value = ''
  showFormModal.value = true
}

async function submitForm() {
  const name = formName.value.trim()
  if (!name) return
  submitting.value = true
  try {
    if (editTarget.value) {
      await watchlistApi.update(editTarget.value.id, { name })
      message.success('重命名成功')
    } else {
      await watchlistApi.create({ name })
      message.success('创建成功')
    }
    showFormModal.value = false
    store.loadWatchlists()
  } catch (err: any) {
    message.error(err.message || '操作失败')
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  store.loadWatchlists()
})
</script>

<style scoped>
.watchlists-view {
  max-width: 1400px;
}
.watchlist-card :deep(.n-tabs) {
  --n-tab-gap: 4px;
}
.watchlist-card :deep(.n-tabs-tab) {
  padding: 6px 12px;
}
.watchlist-card :deep(.n-tabs-tab__label) {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
