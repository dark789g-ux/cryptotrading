<template>
  <div v-if="visible" class="crypto-sync-progress">
    <div class="sync-progress-head">
      <span>{{ sse.phase.value || '同步中' }}</span>
      <span>{{ Math.round(sse.percent.value) }}%</span>
    </div>
    <n-progress
      type="line"
      :percentage="Math.round(sse.percent.value)"
      :status="sse.status.value === 'error' ? 'error' : (finished || sse.status.value === 'done') ? 'success' : 'default'"
      indicator-placement="inside"
    />
    <template v-if="finished">
      <div class="sync-progress-meta">
        <span>{{ sse.message.value }}</span>
      </div>
      <div class="sync-progress-summary">
        写入 {{ finished.result.success }} 行 / 跳过 {{ finished.result.skipped }} 日 / 失败 {{ finished.result.errors.length }} 项<template
          v-if="finished.result.warnings?.length"
        > / 空日警告 {{ finished.result.warnings.length }} 项</template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { Ref } from 'vue'
import { NProgress } from 'naive-ui'

// SyncView 多个 DataSyncModal 的 #extra 进度条统一复刻（瘦身 SyncView）。
// markup/class 名与原内联进度条逐字对齐，无视觉差异。
// ★样式必须本组件自带 <style scoped>（见下）：作为独立组件，其元素拿的是自身 scopeId
//   而非 SyncView 的，靠 SyncView.styles.css 的 scoped 规则盖不到——勿删下方样式块。
interface SseLike {
  phase: Ref<string>
  percent: Ref<number>
  status: Ref<string>
  message: Ref<string>
}

interface FinishedLike {
  // ★warnings 必须可选：本组件被 base-data / crypto / ths 复用，
  //   crypto/ths 的 result 无 warnings 字段，可选保证其零回归（计数与展示不变）。
  result: { success: number; skipped: number; errors: unknown[]; warnings?: unknown[] }
}

defineProps<{
  visible: boolean
  sse: SseLike
  finished?: FinishedLike | null
}>()
</script>

<style scoped>
/* 逐字复刻自 SyncView.styles.css（.crypto-sync-progress / .sync-progress-head）。
   作为独立组件，本组件元素拿的是自身 scopeId 而非 SyncView 的，故必须自带这两条规则，
   否则进度条丢失边框/布局（与 DataSourceCardHeader 自带卡头样式同源）。
   .sync-progress-meta / .sync-progress-summary 在 SyncView.styles.css 中本就无样式，故此处也不补。 */
.crypto-sync-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
}

.sync-progress-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--color-text);
  font-size: 12px;
  font-weight: 700;
}
</style>
