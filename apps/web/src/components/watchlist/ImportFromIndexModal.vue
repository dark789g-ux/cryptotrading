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
          placeholder="请选择指数"
          :disabled="loading"
        />
      </n-form-item>

      <n-alert v-if="selectedCode" type="warning" :show-icon="true" style="margin-top: 12px">
        将从 Tushare 拉取
        <strong>{{ indexOptions.find(o => o.value === selectedCode)?.label }}</strong>
        最新成分股，并<strong>覆盖</strong>「{{ watchlistName }}」现有的
        <strong>{{ currentMemberCount }} 条成员</strong>。此操作不可撤销。
      </n-alert>
    </div>

    <template #actions>
      <n-button :disabled="loading" @click="show = false">取消</n-button>
      <n-button
        type="error"
        :loading="loading"
        :disabled="!selectedCode"
        @click="handleConfirm"
      >
        确认导入
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
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

const INDEX_OPTIONS = [
  { label: '沪深300', value: '399300.SZ' },
  { label: '上证50', value: '000016.SH' },
  { label: '中证500', value: '000905.SH' },
  { label: '中证1000', value: '000852.SH' },
  { label: '上证180', value: '000010.SH' },
]
const indexOptions = INDEX_OPTIONS

watch(show, (v) => {
  if (!v) selectedCode.value = null
})

async function handleConfirm() {
  if (!selectedCode.value) return
  loading.value = true
  try {
    const result = await watchlistApi.importFromIndex(props.watchlistId, selectedCode.value)
    const indexName = INDEX_OPTIONS.find(o => o.value === selectedCode.value)?.label ?? selectedCode.value
    message.success(`已导入 ${result.imported} 支 ${indexName} 成分股`)
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
