<template>
  <div class="regime-quadrant-chrome">
    <n-space align="center" style="margin-bottom: 12px">
      <n-button @click="openAddModal">+ 添加象限</n-button>
      <n-button @click="showImportModal = true">从现有导入</n-button>
      <n-text v-if="overlapWarnings.length > 0" type="warning">
        {{ overlapWarnings.join('；') }}
      </n-text>
    </n-space>

    <n-tabs
      :value="activeTab"
      type="line"
      animated
      :class="{ 'regime-quadrant-chrome__tabs--single': isSingleQuadrant }"
      @update:value="(v: string) => emit('update:activeTab', v)"
    >
      <n-tab-pane
        v-for="(q, idx) in quadrants"
        :key="idx"
        :name="q.key"
        :tab="quadrantTabLabel(q)"
      >
        <slot :quadrant="q" :index="idx" />
        <div v-if="!isSingleQuadrant" style="margin-top: 12px">
          <n-button type="error" @click="emit('remove', idx)">删除此象限</n-button>
        </div>
      </n-tab-pane>
    </n-tabs>

    <n-modal v-model:show="showAddModal" title="添加象限" preset="card" style="width: 400px">
      <n-form label-placement="left" label-width="60">
        <n-form-item label="标签">
          <n-input v-model:value="newLabel" placeholder="象限显示标签" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showAddModal = false">取消</n-button>
          <n-button type="primary" @click="confirmAdd">确定</n-button>
        </n-space>
      </template>
    </n-modal>

    <regime-import-quadrants-modal
      v-model:show="showImportModal"
      @import="(v: QuadrantEntry[]) => emit('import', v)"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import {
  NForm,
  NFormItem,
  NInput,
  NTabs,
  NTabPane,
  NButton,
  NSpace,
  NText,
  NModal,
  useMessage,
} from 'naive-ui'
import RegimeImportQuadrantsModal from '@/components/regime/RegimeImportQuadrantsModal.vue'
import type { QuadrantEntry } from '@/api/modules/strategy/regimeEngine'

defineProps<{
  quadrants: QuadrantEntry[]
  activeTab: string
  overlapWarnings: string[]
  isSingleQuadrant: boolean
}>()

const emit = defineEmits<{
  'update:activeTab': [key: string]
  add: [label: string]
  import: [quadrants: QuadrantEntry[]]
  remove: [index: number]
}>()

const message = useMessage()
const showAddModal = ref(false)
const showImportModal = ref(false)
const newLabel = ref('')

function quadrantTabLabel(q: QuadrantEntry): string {
  return `${q.key} ${q.label}`
}

function openAddModal() {
  newLabel.value = ''
  showAddModal.value = true
}

function confirmAdd() {
  const label = newLabel.value.trim()
  if (!label) {
    message.warning('标签不能为空')
    return
  }
  emit('add', label)
  showAddModal.value = false
  newLabel.value = ''
}
</script>

<style scoped>
.regime-quadrant-chrome__tabs--single :deep(.n-tabs-nav) {
  display: none;
}
</style>
