<template>
  <div class="a-shares-index-panel">
    <n-tabs
      v-model:value="subTab"
      type="line"
      animated
      display-directive="show:lazy"
    >
      <n-tab-pane name="ths" tab="同花顺指数">
        <a-shares-index-ths-panel @jump-to-members="handleJumpToMembers" />
      </n-tab-pane>
      <n-tab-pane name="sw" tab="申万指数">
        <a-shares-index-sw-panel @jump-to-members="handleJumpToMembers" />
      </n-tab-pane>
      <n-tab-pane name="custom" tab="我的指数">
        <a-shares-index-custom-panel
          ref="customPanelRef"
          @jump-to-members="handleJumpToMembers"
          @edit="openEditModal"
        />
      </n-tab-pane>
      <n-tab-pane name="etf" tab="ETF" display-directive="show:lazy">
        <a-shares-index-etf-panel @jump-to-members="handleJumpToMembers" />
      </n-tab-pane>

      <template #suffix>
        <n-button type="primary" size="small" @click="openCreateModal">
          创建指数
        </n-button>
      </template>
    </n-tabs>

    <create-custom-index-modal
      v-model:show="showCreateModal"
      :mode="modalMode"
      :edit-id="editId"
      @saved="onIndexSaved"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesIndexPanel' })

import { onActivated, ref } from 'vue'
import { NButton, NTabPane, NTabs } from 'naive-ui'
import ASharesIndexThsPanel from './ASharesIndexThsPanel.vue'
import ASharesIndexSwPanel from './ASharesIndexSwPanel.vue'
import ASharesIndexCustomPanel from './ASharesIndexCustomPanel.vue'
import ASharesIndexEtfPanel from './ASharesIndexEtfPanel.vue'
import CreateCustomIndexModal from './CreateCustomIndexModal.vue'
import type { CustomIndexLatestRow } from '@/api/modules/market/customIndex'

const emit = defineEmits<{
  (
    e: 'switch-to-stocks',
    payload: {
      tsCode: string
      name: string
      category?: string
      customIndexId?: string
      memberTsCodes?: string[]
    },
  ): void
}>()

type SubTab = 'ths' | 'sw' | 'etf' | 'custom'

const subTab = ref<SubTab>('ths')
const showCreateModal = ref(false)
const modalMode = ref<'create' | 'edit'>('create')
const editId = ref<string | null>(null)
const customPanelRef = ref<{ reload: () => void; onIndexSaved: (p: { id: string; status: string }) => void } | null>(null)

function openCreateModal() {
  if (subTab.value !== 'custom') subTab.value = 'custom'
  modalMode.value = 'create'
  editId.value = null
  showCreateModal.value = true
}

function openEditModal(row: CustomIndexLatestRow) {
  subTab.value = 'custom'
  modalMode.value = 'edit'
  editId.value = row.id
  showCreateModal.value = true
}

function handleJumpToMembers(payload: {
  tsCode: string
  name: string
  category: string
  customIndexId?: string
  memberTsCodes?: string[]
}) {
  emit('switch-to-stocks', {
    tsCode: payload.tsCode,
    name: payload.name,
    category: payload.category,
    customIndexId: payload.customIndexId,
    memberTsCodes: payload.memberTsCodes,
  })
}

function onIndexSaved(payload: { id: string; status: string }) {
  customPanelRef.value?.onIndexSaved(payload)
}

defineExpose({ resize: () => {} })

onActivated(() => {
  // no-op：子面板自行 onActivated reload
})
</script>

<style scoped>
.a-shares-index-panel {
  height: 100%;
}
</style>
