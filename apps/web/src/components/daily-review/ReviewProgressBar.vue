<template>
  <div class="review-progress">
    <n-progress
      type="line"
      :percentage="percent"
      :status="error ? 'error' : (done ? 'success' : 'default')"
      indicator-placement="inside"
    />
    <span class="stage">{{ STAGE_LABEL[stage] }}{{ error ? `：${error}` : '' }}</span>
  </div>
</template>

<script setup lang="ts">
import { NProgress } from 'naive-ui'
import { useDailyReviewProgress } from '@/composables/useDailyReviewProgress'
import { STAGE_LABEL } from '@/types/daily-review'

const props = defineProps<{ tradeDate: string }>()
const { stage, percent, error, done } = useDailyReviewProgress(props.tradeDate)
</script>

<style scoped>
.review-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 220px;
}
.stage {
  font-size: 12px;
  color: var(--color-text-muted);
  white-space: nowrap;
}
</style>
