<template>
  <app-modal
    :show="show"
    title="同步美股数据"
    description="复用量化 jobs 进度推送（SSE）跟进同步进度。"
    width="min(560px, 92vw)"
    :mask-closable="false"
    @update:show="emit('update:show', $event)"
  >
    <div class="us-sync-progress">
      <progress-line
        v-if="jobId"
        :job-id="jobId"
        @done="handleDone"
        @error="handleError"
      />
      <n-empty v-else description="尚未触发同步" size="small" />
    </div>

    <template #actions>
      <n-button :disabled="running" @click="emit('update:show', false)">
        {{ running ? '同步中…' : '关闭' }}
      </n-button>
    </template>
  </app-modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { NButton, NEmpty, useMessage } from 'naive-ui'
import AppModal from '../../common/AppModal.vue'
import ProgressLine from '../../quant/ProgressLine.vue'
import type { JobStatus } from '@/api'

const props = defineProps<{
  show: boolean
  jobId: string | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  done: [state: JobStatus]
}>()

const message = useMessage()
const running = ref(false)

function handleDone(state: JobStatus) {
  running.value = false
  if (state === 'success') {
    message.success('美股数据同步完成')
  } else if (state === 'failed') {
    message.error('美股数据同步失败，请查看量化任务详情')
  } else if (state === 'cancelled') {
    message.warning('美股数据同步已取消')
  }
  emit('done', state)
}

function handleError(msg: string) {
  message.error(msg)
}

watch(
  () => props.jobId,
  (id) => {
    running.value = !!id
  },
)
</script>

<style scoped>
.us-sync-progress {
  min-height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 4px;
}

.us-sync-progress > * {
  width: 100%;
}
</style>
