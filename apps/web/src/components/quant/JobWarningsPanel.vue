<template>
  <div v-if="totalCount > 0" class="job-warnings" data-testid="job-warnings-panel">
    <n-collapse :default-expanded-names="defaultExpanded">
      <n-collapse-item :name="headerName">
        <template #header>
          <span class="warnings-header" data-testid="job-warnings-header">
            <span class="warn-icon">⚠</span>
            警告 ({{ totalCount }} 条)
          </span>
        </template>
        <div v-for="group in grouped" :key="group.type" class="warn-group">
          <div class="warn-group-title">
            {{ group.type }} × {{ group.items.length }}
          </div>
          <ul class="warn-list">
            <li
              v-for="(item, idx) in group.items"
              :key="`${item.factor_id}-${item.trade_date ?? ''}-${item.ts}-${idx}`"
              class="warn-item"
            >
              <span class="mono">{{ item.factor_id }}</span>
              <span v-if="item.trade_date" class="muted"> @ {{ item.trade_date }}</span>
              <span v-if="detailText(item)" class="muted"> ({{ detailText(item) }})</span>
            </li>
          </ul>
        </div>
      </n-collapse-item>
    </n-collapse>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NCollapse, NCollapseItem } from 'naive-ui'
import type { WarningItem } from '@/api/modules/quant'

/**
 * Job 警告折叠面板（PIT 窗口护门 spec §6.3）。
 *
 * 渲染 ml.jobs.warnings 数组，按 type 分组聚合：
 *   ⚠ 警告 (4 条)  [展开]
 *     ▼ factor_window_short × 3
 *         momentum_20d @ 20260206  (18 < 21)
 *         ...
 *
 * 当前实现仅消费 GET /quant/jobs/:id 拉到的全量明细；
 * SSE 增量 summary 由父组件叠加显示 totalCount（暂不渲染明细差异）。
 */
const props = withDefaults(
  defineProps<{
    warnings: WarningItem[]
    /** 默认展开（详情页打开时展开一次便于查看） */
    defaultOpen?: boolean
  }>(),
  { defaultOpen: false },
)

const headerName = 'warnings'

const defaultExpanded = computed<string[]>(() =>
  props.defaultOpen ? [headerName] : [],
)

const totalCount = computed(() => props.warnings.length)

interface Group {
  type: string
  items: WarningItem[]
}

const grouped = computed<Group[]>(() => {
  const map = new Map<string, WarningItem[]>()
  for (const w of props.warnings) {
    const list = map.get(w.type)
    if (list) list.push(w)
    else map.set(w.type, [w])
  }
  return Array.from(map.entries()).map(([type, items]) => ({ type, items }))
})

/**
 * 把 detail 拍平为一行短文案（用户最关心的对照值）。
 * 已知形态：
 *   factor_window_short → { declared: 18, required: 21 } → "18 < 21"
 *   其它类型 → JSON 紧凑串
 */
function detailText(item: WarningItem): string {
  const d = item.detail
  if (!d) return ''
  if (
    item.type === 'factor_window_short'
    && typeof d.declared === 'number'
    && typeof d.required === 'number'
  ) {
    return `${d.declared} < ${d.required}`
  }
  try {
    return JSON.stringify(d)
  } catch {
    return ''
  }
}
</script>

<style scoped>
.job-warnings {
  margin-top: 12px;
}
.warnings-header {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-warning, #f0a020);
  font-weight: 500;
}
.warn-icon {
  font-size: 14px;
}
.warn-group + .warn-group {
  margin-top: 8px;
}
.warn-group-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  margin-bottom: 2px;
}
.warn-list {
  list-style: none;
  margin: 0;
  padding: 0 0 0 14px;
}
.warn-item {
  font-size: 12px;
  line-height: 1.6;
}
.mono {
  font-family: 'Menlo', 'Consolas', monospace;
}
.muted {
  color: var(--color-text-muted);
}
</style>
