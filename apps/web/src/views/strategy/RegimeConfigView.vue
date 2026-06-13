<template>
  <div class="regime-config-view workspace-page workspace-page--medium">
    <div class="workspace-page-header">
      <div>
        <h1 class="workspace-page-title">Regime 配置管理</h1>
        <p class="page-subtitle">管理不同市场象限下的选股策略配置</p>
      </div>
      <div class="header-actions">
        <n-button
          v-if="isAdmin"
          type="primary"
          @click="openCreate"
        >
          新建配置
        </n-button>
      </div>
    </div>

    <n-card :bordered="false">
      <n-data-table
        :columns="columns"
        :data="sortedConfigs"
        :loading="store.loading"
        :bordered="false"
        :pagination="pagination"
        size="small"
      />
    </n-card>

    <AppModal
      v-model:show="showModal"
      :title="modalTitle"
      width="min(900px, 96vw)"
      :mask-closable="false"
    >
      <RegimeConfigEditor
        :mode="editorMode"
        :initial-data="editorInitialData"
        @save="handleEditorSave"
        @cancel="showModal = false"
      />
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NSpace,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { useAuth } from '@/composables/hooks/useAuth'
import { useRegimeConfigStore } from '@/stores/regimeConfig'
import type {
  RegimeStrategyConfig,
  CreateRegimeConfigDto,
  UpdateRegimeConfigDto,
} from '@/api/modules/strategy/regimeEngine'
import AppModal from '@/components/common/AppModal.vue'
import RegimeConfigEditor from '@/components/regime/RegimeConfigEditor.vue'

const message = useMessage()
const auth = useAuth()
const isAdmin = computed(() => auth.isAdmin.value)
const store = useRegimeConfigStore()

const STATUS_MAP: Record<string, { type: 'success' | 'warning' | 'default'; label: string }> = {
  draft: { type: 'default', label: 'draft' },
  active: { type: 'success', label: 'active' },
  archived: { type: 'warning', label: 'archived' },
}

const sortedConfigs = computed(() =>
  [...store.configs].sort((a, b) => b.version - a.version),
)

const columns: DataTableColumns<RegimeStrategyConfig> = [
  {
    title: '版本',
    key: 'version',
    width: 80,
    render: (row) => `v${row.version}`,
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) => {
      const info = STATUS_MAP[row.status] ?? { type: 'default' as const, label: row.status }
      return h(NTag, { type: info.type, bordered: false, size: 'small' }, { default: () => info.label })
    },
  },
  {
    title: '备注',
    key: 'note',
    minWidth: 160,
    ellipsis: { lineClamp: 3, tooltip: true },
    render: (row) => row.note ?? '-',
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 160,
    render: (row) => formatDateTime(row.createdAt),
  },
  {
    title: '操作',
    key: 'actions',
    width: 200,
    render: (row) => {
      const buttons = []
      if (isAdmin.value && row.status === 'draft') {
        buttons.push(
          h(NButton, { size: 'small', onClick: () => openEdit(row) }, { default: () => '编辑' }),
        )
      }
      buttons.push(
        h(NButton, { size: 'small', onClick: () => handleDuplicate(row) }, { default: () => '复制' }),
      )
      if (isAdmin.value && row.status === 'draft') {
        buttons.push(
          h(NButton, { size: 'small', type: 'primary', onClick: () => handleActivate(row) }, { default: () => '激活' }),
        )
      }
      return h(NSpace, { size: 4 }, { default: () => buttons })
    },
  },
]

const pagination = { defaultPageSize: 20 }

function formatDateTime(input: string): string {
  if (!input) return '-'
  const d = new Date(input)
  if (isNaN(d.getTime())) return input
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

const showModal = ref(false)
const editorMode = ref<'create' | 'edit' | 'duplicate'>('create')
const editorInitialData = ref<RegimeStrategyConfig | null>(null)
const editingConfigId = ref<string | null>(null)

const modalTitle = computed(() => {
  const titles = { create: '新建配置', edit: '编辑配置', duplicate: '复制配置' }
  return titles[editorMode.value]
})

function openCreate() {
  editorMode.value = 'create'
  editorInitialData.value = null
  showModal.value = true
}

function openEdit(row: RegimeStrategyConfig) {
  editorMode.value = 'edit'
  editorInitialData.value = row
  editingConfigId.value = row.id
  showModal.value = true
}

function handleDuplicate(row: RegimeStrategyConfig) {
  editorMode.value = 'duplicate'
  editorInitialData.value = row
  showModal.value = true
}

async function handleEditorSave(dto: CreateRegimeConfigDto) {
  try {
    if (editorMode.value === 'edit' && editingConfigId.value) {
      const updateDto: UpdateRegimeConfigDto = {
        version: dto.version,
        note: dto.note,
        config: dto.config,
      }
      await store.updateConfig(editingConfigId.value, updateDto)
      showModal.value = false
      message.success('保存成功')
    } else {
      await store.createConfig(dto)
      showModal.value = false
      message.success(editorMode.value === 'create' ? '创建成功' : '复制成功')
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '操作失败'
    message.error(msg)
  }
}

async function handleActivate(row: RegimeStrategyConfig) {
  try {
    await store.activateConfig(row.id)
    message.success(`v${row.version} 已激活`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '激活失败'
    message.error(msg)
  }
}

onMounted(() => {
  store.fetchConfigs()
})
</script>

<style scoped>
.regime-config-view {
  padding: 16px;
}

.page-subtitle {
  margin: 6px 0 0;
  color: var(--color-text-secondary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
</style>
