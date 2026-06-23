<template>
  <div ref="containerRef" class="kline-with-info-panel">
    <div ref="klineAreaRef" class="kline-with-info-panel__kline">
      <slot name="kline" />
      <n-button
        v-if="!expanded"
        quaternary
        circle
        size="small"
        class="kline-with-info-panel__trigger"
        aria-label="标的信息"
        :aria-expanded="expanded"
        :aria-controls="asideId"
        :disabled="!canExpand"
        @click="toggle"
      >
        <template #icon>
          <n-icon><InformationCircleOutline /></n-icon>
        </template>
      </n-button>
    </div>
    <aside :id="asideId" v-show="expanded" class="kline-with-info-panel__aside">
      <div class="kline-with-info-panel__header">
        <span class="kline-with-info-panel__title">{{ infoTitle }}</span>
        <n-button
          quaternary
          circle
          size="small"
          class="kline-with-info-panel__collapse"
          aria-label="收起"
          @click="collapse"
        >
          <template #icon>
            <n-icon><Close /></n-icon>
          </template>
        </n-button>
      </div>
      <div class="kline-with-info-panel__body">
        <slot name="info" />
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'KlineWithInfoPanel' })

import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { InformationCircleOutline, Close } from '@vicons/ionicons5'

const props = withDefaults(
  defineProps<{
    /** localStorage key，按标的类型区分 */
    storageKey: string
    /** 侧栏标题 */
    infoTitle?: string
  }>(),
  {
    infoTitle: '标的信息',
  },
)

const MIN_KLINE_WIDTH = 360
const ASIDE_WIDTH = 260
/** 容器可用宽度阈值：K 线最小宽 + 侧栏宽 */
const EXPAND_THRESHOLD = MIN_KLINE_WIDTH + ASIDE_WIDTH // 620

const klineAreaRef = ref<HTMLElement | null>(null)
const containerRef = ref<HTMLElement | null>(null)
// aside 的 id，供触发按钮 aria-controls 引用。基于 storageKey 派生保证多实例不冲突。
const asideId = `kline-info-aside-${props.storageKey}`
const expanded = ref<boolean>(readExpandedFromStorage(props.storageKey))
// 首次默认 true（假设空间充足）；ResizeObserver 首次回调会按真实宽度修正。
const canExpand = ref(true)
let resizeObserver: ResizeObserver | null = null

function readExpandedFromStorage(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true'
  } catch {
    return false
  }
}

function writeExpandedToStorage(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? 'true' : 'false')
  } catch {
    /* localStorage 可能不可用 */
  }
}

function expand() {
  if (!canExpand.value) return
  expanded.value = true
}

function collapse() {
  expanded.value = false
}

function toggle() {
  if (expanded.value) {
    collapse()
  } else {
    expand()
  }
}

function updateCanExpandFromWidth(width: number) {
  const next = width >= EXPAND_THRESHOLD
  if (next !== canExpand.value) {
    canExpand.value = next
  }
  // 宽度不足且当前展开 → 自动折叠
  if (!next && expanded.value) {
    expanded.value = false
  }
  // 宽度恢复 ≥ 阈值：不自动展开（需用户主动点）
}

function handleResize(entries: ResizeObserverEntry[]) {
  // 观测外层容器宽度（不受 expanded 状态影响）；kline 区宽度会随 aside 显隐变化，
  // 不能作为"容器可用宽度"判定依据，否则展开后 kline 区收缩会触发误折叠。
  const width =
    entries[0]?.contentRect.width ?? containerRef.value?.clientWidth ?? 0
  updateCanExpandFromWidth(width)
}

watch(
  () => expanded.value,
  (val) => writeExpandedToStorage(props.storageKey, val),
)

onMounted(() => {
  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<style scoped>
.kline-with-info-panel {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.kline-with-info-panel__kline {
  position: relative;
  flex: 1 1 auto;
  min-width: 360px;
  height: 100%;
  min-height: 0;
}

.kline-with-info-panel__trigger {
  position: absolute;
  /* 留出 KlineChart toolbar 高度 (44px) + gap (8px) + 少许间距 */
  top: 56px;
  right: 6px;
  z-index: 2;
}

.kline-with-info-panel__aside {
  flex: 0 0 260px;
  width: 260px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid rgba(128, 128, 128, 0.2);
}

.kline-with-info-panel__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
}

.kline-with-info-panel__title {
  font-size: 13px;
  font-weight: 600;
}

.kline-with-info-panel__body {
  flex: 1 1 auto;
  overflow: auto;
  min-height: 0;
  padding: 8px;
}
</style>
