<template>
  <div class="symbols-panel-layout">
    <header class="panel-header">
      <n-space align="center" :wrap="false" class="header-left">
        <n-button :loading="loading" @click="handleRefresh">
          <template #icon>
            <n-icon><refresh-outline /></n-icon>
          </template>
          Refresh
        </n-button>
        <n-tooltip>
          <template #trigger>
            <n-button secondary @click="toggleViewMode">
              <template #icon>
                <n-icon>
                  <component :is="viewMode === 'table' ? GridOutline : ListOutline" />
                </n-icon>
              </template>
            </n-button>
          </template>
          {{ viewMode === 'table' ? '切换为分栏视图' : '切换为表格视图' }}
        </n-tooltip>
      </n-space>
      <div class="header-actions">
        <slot name="header-actions" />
      </div>
    </header>

    <div class="panel-filters">
      <slot name="filters" />
    </div>

    <div class="panel-body" :class="{ 'is-split': viewMode === 'split' }">
      <template v-if="viewMode === 'table'">
        <slot name="table" />
      </template>
      <resizable-split-pane
        v-else
        v-model:left-width="leftWidth"
      >
        <template #left>
          <slot name="split-left" />
        </template>
        <template #right>
          <slot v-if="!showEmptyDetail" name="split-right" />
          <slot v-else name="empty-detail" />
        </template>
      </resizable-split-pane>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * SymbolsPanelLayout：通用标的面板外壳组件。
 * - 负责外壳布局、视图切换、状态持久化、两种形态的容器渲染。
 * - 不感知具体市场业务，通过 scope 区分不同面板的 localStorage 命名空间。
 *
 * 关于 empty-detail：
 * 本组件通过 showEmptyDetail prop 决定分栏视图右侧渲染 split-right 还是 empty-detail slot。
 * 父组件（业务面板）控制该状态，从而保持外壳本身不感知“选中/未选中”等业务语义。
 */
defineOptions({ name: 'SymbolsPanelLayout' })

import { computed, ref, watch } from 'vue'
import { NButton, NIcon, NSpace, NTooltip } from 'naive-ui'
import {
  GridOutline,
  ListOutline,
  RefreshOutline,
} from '@vicons/ionicons5'
import ResizableSplitPane from './ResizableSplitPane.vue'

const props = withDefaults(
  defineProps<{
    scope: 'crypto' | 'aShares' | 'usStocks'
    loading?: boolean
    viewMode?: 'table' | 'split'
    leftWidth?: number
    showEmptyDetail?: boolean
  }>(),
  {
    loading: false,
    showEmptyDetail: false,
  },
)

const emit = defineEmits<{
  'update:viewMode': [value: 'table' | 'split']
  'update:leftWidth': [value: number]
  refresh: []
}>()

const VIEW_MODE_KEY = (scope: string) => `symbols_panel_view_mode_${scope}`
const LEFT_WIDTH_KEY = (scope: string) => `symbols_panel_split_width_${scope}`

function readValidViewMode(scope: string): 'table' | 'split' {
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY(scope))
    if (raw === 'table' || raw === 'split') return raw
  } catch {
    /* localStorage 可能不可用 */
  }
  return 'table'
}

function readValidLeftWidth(scope: string): number {
  try {
    const raw = localStorage.getItem(LEFT_WIDTH_KEY(scope))
    const num = raw === null ? NaN : Number(raw)
    if (!Number.isNaN(num) && num >= 0.2 && num <= 0.6) return num
  } catch {
    /* localStorage 可能不可用 */
  }
  return 0.4
}

function persistViewMode(scope: string, value: 'table' | 'split') {
  try {
    localStorage.setItem(VIEW_MODE_KEY(scope), value)
  } catch {
    /* ignore */
  }
}

function persistLeftWidth(scope: string, value: number) {
  try {
    localStorage.setItem(LEFT_WIDTH_KEY(scope), String(value))
  } catch {
    /* ignore */
  }
}

// 当对应 prop 未被父组件绑定时，使用内部持久化状态。
const persistedViewMode = ref<'table' | 'split'>(readValidViewMode(props.scope))
const persistedLeftWidth = ref<number>(readValidLeftWidth(props.scope))

const viewMode = computed<'table' | 'split'>({
  get() {
    return props.viewMode ?? persistedViewMode.value
  },
  set(value) {
    persistedViewMode.value = value
    persistViewMode(props.scope, value)
    emit('update:viewMode', value)
  },
})

const leftWidth = computed<number>({
  get() {
    return props.leftWidth ?? persistedLeftWidth.value
  },
  set(value) {
    const clamped = Math.max(0.2, Math.min(0.6, value))
    persistedLeftWidth.value = clamped
    persistLeftWidth(props.scope, clamped)
    emit('update:leftWidth', clamped)
  },
})

// 当父组件通过 prop 外部更新状态时，同步内部状态，保持 v-model 双向一致。
watch(
  () => props.viewMode,
  (value) => {
    if (value !== undefined) persistedViewMode.value = value
  },
)

watch(
  () => props.leftWidth,
  (value) => {
    if (value !== undefined) persistedLeftWidth.value = value
  },
)

function toggleViewMode() {
  viewMode.value = viewMode.value === 'table' ? 'split' : 'table'
}

function handleRefresh() {
  emit('refresh')
}
</script>

<style scoped>
.symbols-panel-layout {
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.header-left {
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-filters {
  flex-shrink: 0;
}

.panel-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.panel-body.is-split {
  min-height: 320px;
}
</style>
