<template>
  <n-card size="small" :bordered="false" class="run-header">
    <div class="row">
      <div class="ids">
        <div class="title-line">
          <h2 class="model-version">{{ run.model_version }}</h2>
          <n-tag :type="evaluatedTag" size="small">{{ evaluatedText }}</n-tag>
        </div>
        <div class="sub">
          <span class="mono">id: {{ run.id }}</span>
          <span class="dot">·</span>
          <span>创建于 {{ run.created_at || '—' }}</span>
          <span class="dot">·</span>
          <span>feature_set_id: <span class="mono">{{ run.feature_set_id }}</span></span>
          <template v-if="run.job_id">
            <span class="dot">·</span>
            <span>job: <span class="mono">{{ run.job_id }}</span></span>
          </template>
        </div>
      </div>
      <div class="right">
        <slot name="actions" />
      </div>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NTag } from 'naive-ui'
import type { ModelRunDetail } from '@/api/modules/quant'

const props = defineProps<{ run: ModelRunDetail }>()

const evaluatedTag = computed<'success' | 'warning'>(() => {
  const c = props.run.oos_metrics_core
  const ok = !!c && (c.ndcg_at_10 !== null || c.ic !== null || c.rank_ic !== null
    || c.portfolio_annual_after_cost !== null)
  return ok ? 'success' : 'warning'
})
const evaluatedText = computed(() =>
  evaluatedTag.value === 'success' ? '已评估' : '待评估',
)
</script>

<style scoped>
.run-header { margin-bottom: 12px; }
.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.title-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}
.model-version {
  margin: 0;
  font-size: 18px;
  font-family: 'Menlo', 'Consolas', monospace;
}
.sub {
  color: var(--color-text-muted);
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.dot { color: var(--color-text-muted); }
.mono { font-family: 'Menlo', 'Consolas', monospace; }
.right { display: flex; gap: 8px; }
</style>
