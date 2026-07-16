<template>
  <n-card class="settings-card" :bordered="false">
    <template #header>
      <div class="card-header-row">
        <span>API Keys</span>
        <n-button type="primary" size="small" @click="showCreateModal = true">
          + 新建 API Key
        </n-button>
      </div>
    </template>
    <p class="card-desc">
      供 Agent 等外部程序调用本系统接口。创建后仅显示一次完整密钥，请妥善保存。
    </p>

    <n-spin :show="loading">
      <template v-if="keys.length === 0 && !loading">
        <n-empty description="还没有 API Key" />
      </template>
      <n-data-table
        v-else
        :columns="columns"
        :data="keys"
        :bordered="false"
        :single-line="false"
      />
    </n-spin>
  </n-card>

  <!-- 新建对话框 -->
  <AppModal
    v-model:show="showCreateModal"
    title="新建 API Key"
    :header-icon="AddOutline"
    width="min(460px, 90vw)"
  >
    <n-form label-placement="top">
      <n-form-item label="名称">
        <n-input
          v-model:value="newName"
          placeholder="如:Agent-回测"
          :maxlength="64"
          @keydown.enter="create"
        />
      </n-form-item>
    </n-form>
    <template #actions>
      <n-button @click="showCreateModal = false">取消</n-button>
      <n-button type="primary" :loading="creating" @click="create">创建</n-button>
    </template>
  </AppModal>

  <!-- 创建成功 - 明文密钥展示 -->
  <AppModal
    v-model:show="showResultModal"
    title="API Key 创建成功"
    :header-icon="CheckmarkCircleOutline"
    width="min(540px, 92vw)"
    :mask-closable="false"
  >
    <n-alert type="warning" :bordered="false" style="margin-bottom: 16px">
      这是您唯一一次看到完整密钥，请立即复制保存！
    </n-alert>

    <n-form label-placement="top">
      <n-form-item label="名称">
        <span>{{ lastCreated?.name }}</span>
      </n-form-item>
      <n-form-item label="完整密钥">
        <div class="key-display-row">
          <n-input
            :value="lastCreated?.plaintextKey ?? ''"
            readonly
            class="key-input"
            :input-props="{ style: 'font-family: monospace' }"
          />
          <n-button type="primary" @click="copyKey">复制</n-button>
        </div>
      </n-form-item>
    </n-form>

    <div class="usage-hint">
      <strong>使用方式：</strong>
      <code>Authorization: Bearer ct_live_xxx...</code>
    </div>

    <template #actions>
      <n-button type="primary" @click="showResultModal = false">我已保存，关闭</n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { h, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NSpin,
  NTag,
  NPopconfirm,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { AddOutline, CheckmarkCircleOutline, TrashOutline } from '@vicons/ionicons5'
import { apiKeysApi, type ApiKeyView, type CreatedApiKey } from '../../composables/api/apiKeysApi'
import AppModal from '@/components/common/AppModal.vue'

const message = useMessage()

const loading = ref(false)
const keys = ref<ApiKeyView[]>([])
const showCreateModal = ref(false)
const showResultModal = ref(false)
const creating = ref(false)
const newName = ref('')
const lastCreated = ref<CreatedApiKey | null>(null)

function maskPrefix(prefix: string): string {
  return prefix.length > 12 ? prefix.slice(0, 12) + '***' : prefix
}

function formatRelative(iso: string | null): string {
  if (!iso) return '从未'
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`
  return new Date(iso).toLocaleDateString()
}

function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

const columns: DataTableColumns<ApiKeyView> = [
  { title: '名称', key: 'name', ellipsis: { tooltip: true } },
  {
    title: '前缀',
    key: 'keyPrefix',
    width: 180,
    render: (row) => h('code', { style: 'font-size: 12px; opacity: 0.85' }, maskPrefix(row.keyPrefix)),
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 170,
    render: (row) => formatLocalTime(row.createdAt),
  },
  {
    title: '最后使用',
    key: 'lastUsedAt',
    width: 120,
    render: (row) => {
      const text = formatRelative(row.lastUsedAt)
      const type = row.lastUsedAt ? 'default' : 'info'
      return h(NTag, { size: 'small', type, bordered: false }, { default: () => text })
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 80,
    align: 'center',
    render: (row) =>
      h(
        NPopconfirm,
        { onPositiveClick: () => revoke(row.id) },
        {
          trigger: () =>
            h(
              NButton,
              { size: 'small', quaternary: true, type: 'error' },
              { icon: () => h(NIcon, null, { default: () => h(TrashOutline) }) },
            ),
          default: () => '确定撤销此 API Key？撤销后不可恢复。',
        },
      ),
  },
]

async function load() {
  loading.value = true
  try {
    keys.value = await apiKeysApi.list()
  } catch (err: any) {
    message.error(err.message || '加载失败')
  } finally {
    loading.value = false
  }
}

async function create() {
  const name = newName.value.trim()
  if (!name) {
    message.warning('请输入名称')
    return
  }
  creating.value = true
  try {
    const created = await apiKeysApi.create({ name })
    lastCreated.value = created
    showCreateModal.value = false
    showResultModal.value = true
    newName.value = ''
    await load()
  } catch (err: any) {
    message.error(err.message || '创建失败')
  } finally {
    creating.value = false
  }
}

async function revoke(id: string) {
  try {
    await apiKeysApi.revoke(id)
    message.success('已撤销')
    await load()
  } catch (err: any) {
    message.error(err.message || '撤销失败')
  }
}

async function copyKey() {
  if (!lastCreated.value) return
  try {
    await navigator.clipboard.writeText(lastCreated.value.plaintextKey)
    message.success('已复制')
  } catch {
    message.error('复制失败，请手动复制')
  }
}

onMounted(load)
</script>

<style scoped>
.card-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.card-desc {
  margin: 0 0 16px;
  font-size: 14px;
  color: var(--ember-text-secondary);
}

.key-display-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.key-input {
  flex: 1;
}

.usage-hint {
  margin-top: 12px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.usage-hint code {
  display: block;
  margin-top: 4px;
  padding: 8px 12px;
  background: var(--color-border);
  border-radius: 6px;
  font-family: monospace;
  font-size: 12px;
  word-break: break-all;
}
</style>
