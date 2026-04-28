<template>
  <div class="watchlist-sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">自选列表</span>
      <n-button text size="small" @click="createList">
        <template #icon>
          <n-icon><add-outline /></n-icon>
        </template>
      </n-button>
    </div>

    <n-spin v-if="store.loadingLists" size="small" />

    <div v-else class="sidebar-list">
      <div
        v-for="wl in store.watchlists"
        :key="wl.id"
        :class="['sidebar-item', { active: wl.id === store.currentId }]"
        @click="store.setCurrentId(wl.id)"
        @contextmenu.prevent="showContextMenu($event, wl)"
      >
        <span class="item-name">{{ wl.name }}</span>
        <n-badge :value="wl.items?.length ?? 0" />
      </div>
    </div>

    <!-- 新建/重命名弹窗 -->
    <n-modal v-model:show="showModal" :title="editTarget ? '重命名列表' : '新建列表'" preset="dialog">
      <n-input v-model:value="formName" placeholder="列表名称" @keyup.enter="submitName" />
      <template #action>
        <n-button @click="showModal = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submitName">保存</n-button>
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
import { ref } from 'vue'
import {
  NButton, NBadge, NDropdown, NIcon, NInput, NModal, NSpin,
  useMessage, useDialog,
} from 'naive-ui'
import { AddOutline } from '@vicons/ionicons5'
import { useWatchlistStore } from '@/stores/watchlist'
import { watchlistApi } from '@/api'

const store = useWatchlistStore()
const message = useMessage()
const dialog = useDialog()

const showModal = ref(false)
const submitting = ref(false)
const editTarget = ref<typeof store.watchlists[0] | null>(null)
const formName = ref('')

const dropdownVisible = ref(false)
const dropdownX = ref(0)
const dropdownY = ref(0)
const contextMenuTarget = ref<typeof store.watchlists[0] | null>(null)

const dropdownOptions = [
  { label: '重命名', key: 'rename' },
  { label: '删除', key: 'delete' },
]

function showContextMenu(e: MouseEvent, wl: typeof store.watchlists[0]) {
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
    showModal.value = true
  } else if (key === 'delete') {
    dialog.warning({
      title: '确认删除',
      content: `确定要删除列表 "${wl.name}" 吗？`,
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: async () => {
        await watchlistApi.delete(wl.id)
        message.success('删除成功')
        store.loadWatchlists()
      },
    })
  }
}

function createList() {
  editTarget.value = null
  formName.value = ''
  showModal.value = true
}

async function submitName() {
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
    showModal.value = false
    store.loadWatchlists()
  } catch (err: any) {
    message.error(err.message || '操作失败')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.watchlist-sidebar {
  width: 240px;
  border-right: 1px solid var(--ember-border);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.sidebar-title {
  font-weight: 600;
  font-size: 16px;
}
.sidebar-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sidebar-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}
.sidebar-item:hover {
  background: var(--ember-hover);
}
.sidebar-item.active {
  background: var(--ember-active);
  font-weight: 600;
}
.item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
