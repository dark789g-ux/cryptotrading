<template>
  <AppModal
    v-model:show="show"
    title="从指数导入成员"
    width="min(480px, 90vw)"
    :mask-closable="!loading"
    :closable="!loading"
  >
    <div class="import-index-body">
      <n-form-item label="选择指数" :show-feedback="false">
        <n-select
          v-model:value="selectedCode"
          :options="indexOptions"
          :loading="optionsLoading"
          :disabled="loading || optionsLoading"
          filterable
          placeholder="搜索或选择指数"
          :filter="filterOption"
        />
      </n-form-item>

      <n-alert v-if="optionsError" type="error" :show-icon="true" style="margin-top: 12px">
        加载指数列表失败，请确认服务端已配置 TUSHARE_TOKEN，然后关闭重试
      </n-alert>

      <n-alert v-else-if="selectedCode" type="warning" :show-icon="true" style="margin-top: 12px">
        将从 Tushare 拉取
        <strong>{{ selectedLabel }}</strong>
        最新成分股，并<strong>覆盖</strong>「{{ watchlistName }}」现有的
        <strong>{{ currentMemberCount }} 条成员</strong>。此操作不可撤销。
      </n-alert>
    </div>

    <template #actions>
      <n-button :disabled="loading" @click="show = false">取消</n-button>
      <n-button
        type="error"
        :loading="loading"
        :disabled="!selectedCode || optionsLoading"
        @click="handleConfirm"
      >
        确认导入
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { NAlert, NButton, NFormItem, NSelect, useMessage } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import { watchlistApi } from '@/api'

const props = defineProps<{
  show: boolean
  watchlistId: string
  watchlistName: string
  currentMemberCount: number
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  imported: [count: number]
}>()

const show = ref(props.show)
watch(() => props.show, (v) => { show.value = v })
watch(show, (v) => emit('update:show', v))

const message = useMessage()
const loading = ref(false)
const selectedCode = ref<string | null>(null)

const indexOptions = ref<{ value: string; label: string }[]>([])
const optionsLoading = ref(false)
const optionsError = ref(false)

const selectedLabel = computed(() =>
  indexOptions.value.find((o) => o.value === selectedCode.value)?.label ?? selectedCode.value ?? ''
)

function filterOption(pattern: string, option: { label: string; value: string }) {
  const q = pattern.toLowerCase()
  return option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q)
}

async function loadIndexOptions() {
  if (indexOptions.value.length > 0) return
  optionsLoading.value = true
  optionsError.value = false
  try {
    indexOptions.value = await watchlistApi.listIndexOptions()
  } catch {
    optionsError.value = true
  } finally {
    optionsLoading.value = false
  }
}

onMounted(() => {
  if (show.value) loadIndexOptions()
})

watch(show, (v) => {
  if (v) {
    loadIndexOptions()
  } else {
    selectedCode.value = null
  }
})

async function handleConfirm() {
  if (!selectedCode.value) return
  loading.value = true
  try {
    const result = await watchlistApi.importFromIndex(props.watchlistId, selectedCode.value)
    message.success(`已导入 ${result.imported} 支 ${selectedLabel.value} 成分股`)
    show.value = false
    emit('imported', result.imported)
  } catch (err: any) {
    const msg: string = err?.response?.data?.message ?? err?.message ?? '操作失败'
    if (msg.includes('未找到')) {
      message.error('未找到该指数成分数据')
    } else {
      message.error('获取指数成分失败，请稍后重试')
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.import-index-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
