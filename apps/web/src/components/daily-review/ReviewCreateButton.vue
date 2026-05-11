<template>
  <template v-if="auth.isAdmin.value">
    <n-button type="primary" @click="open = true">新增复盘</n-button>
    <AppModal v-model:show="open" title="新增复盘">
      <n-form-item label="交易日">
        <n-date-picker v-model:value="ts" type="date" />
      </n-form-item>
      <n-alert v-if="exists" type="warning" style="margin-top: 8px;">
        该交易日已有复盘，提交将覆盖现有版本
      </n-alert>
      <template #actions>
        <n-button @click="open = false">取消</n-button>
        <n-button type="primary" :loading="loading" @click="submit">确认生成</n-button>
      </template>
    </AppModal>
  </template>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NDatePicker, NFormItem, NAlert, useMessage } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import { useAuth } from '@/composables/hooks/useAuth'
import { useDailyReviewApi } from '@/composables/useDailyReviewApi'

const emit = defineEmits<{ created: [tradeDate: string] }>()
const props = defineProps<{ existingDates: string[] }>()

const auth = useAuth()
const api = useDailyReviewApi()
const msg = useMessage()
const open = ref(false)
const loading = ref(false)

// 默认取今日本地午夜 ms（CLAUDE.md 日期选择器本地 TZ 例外）
const defaultTs = (() => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
})()
const ts = ref<number | null>(defaultTs)

function formatYmd(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
const tradeDate = computed(() => ts.value ? formatYmd(ts.value) : '')
const exists = computed(() => !!(tradeDate.value && props.existingDates.includes(tradeDate.value)))

async function submit() {
  if (!ts.value) return
  loading.value = true
  try {
    await api.create(tradeDate.value)
    open.value = false
    emit('created', tradeDate.value)
  } catch (err: any) {
    msg.error(err?.message || '提交失败')
  } finally {
    loading.value = false
  }
}
</script>
