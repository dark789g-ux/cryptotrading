<template>
  <div
    ref="containerRef"
    class="rsp-split-pane"
    :class="{ 'is-narrow': isNarrow }"
    :style="cssVars"
  >
    <div class="rsp-left">
      <slot name="left" />
    </div>
    <div ref="dividerRef" class="rsp-divider" @pointerdown="onPointerDown">
      <div class="rsp-divider-handle" />
    </div>
    <div class="rsp-right">
      <slot name="right" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * ResizableSplitPane：通用可拖拽左右分栏组件。
 * - 纯 UI，无业务状态。
 * - 通过 pointer 事件支持鼠标与触摸拖拽。
 * - ≤960px 时退化为上下堆叠。
 */
defineOptions({ name: 'ResizableSplitPane' })

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    leftWidth?: number
    minWidthPx?: number
    maxRatio?: number
  }>(),
  {
    leftWidth: 0.4,
    minWidthPx: 240,
    maxRatio: 0.6,
  },
)

const emit = defineEmits<{
  'update:leftWidth': [value: number]
}>()

const containerRef = ref<HTMLElement | null>(null)
const dividerRef = ref<HTMLElement | null>(null)

// 内部维护一个与 prop 同步的比例值，拖拽时直接修改它，结束后再通知父组件。
const innerRatio = ref(props.leftWidth)

function clampRatio(ratio: number, containerWidth: number): number {
  const minWidthPx = Math.max(0, props.minWidthPx)
  const maxWidthPx = props.maxRatio * containerWidth
  const minRatio = containerWidth > 0 ? minWidthPx / containerWidth : 0
  const maxRatio = containerWidth > 0 ? maxWidthPx / containerWidth : props.maxRatio
  return Math.max(minRatio, Math.min(maxRatio, ratio))
}

function syncRatioToContainer() {
  if (!containerRef.value) return
  const width = containerRef.value.getBoundingClientRect().width
  innerRatio.value = clampRatio(innerRatio.value, width)
}

watch(
  () => props.leftWidth,
  (value) => {
    innerRatio.value = value
    nextTick(syncRatioToContainer)
  },
)

onMounted(() => {
  syncRatioToContainer()
})

const cssVars = computed(() => ({
  '--left-ratio': innerRatio.value,
}))

const isNarrow = ref(false)
const narrowMediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(max-width: 960px)')
  : null
function updateNarrow() {
  isNarrow.value = narrowMediaQuery?.matches ?? false
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  updateNarrow()
  narrowMediaQuery?.addEventListener('change', updateNarrow)

  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => syncRatioToContainer())
    resizeObserver.observe(containerRef.value)
  }
})

onBeforeUnmount(() => {
  narrowMediaQuery?.removeEventListener('change', updateNarrow)
  if (resizeObserver && containerRef.value) {
    resizeObserver.unobserve(containerRef.value)
    resizeObserver.disconnect()
  }
})

let isDragging = false
let startX = 0
let startRatio = 0
let containerStartWidth = 0
let originalUserSelect = ''
let originalCursor = ''

function onPointerDown(event: PointerEvent) {
  if (!containerRef.value) return

  event.preventDefault()

  isDragging = true
  startX = event.clientX
  startRatio = innerRatio.value

  const rect = containerRef.value.getBoundingClientRect()
  containerStartWidth = rect.width

  const divider = dividerRef.value
  divider?.addEventListener('pointermove', onPointerMove)
  divider?.addEventListener('pointerup', onPointerUp)
  divider?.addEventListener('pointercancel', onPointerUp)
  divider?.addEventListener('pointerleave', onPointerUp)
  if (divider && 'setPointerCapture' in divider) {
    divider.setPointerCapture(event.pointerId)
  }

  originalUserSelect = document.body.style.userSelect
  originalCursor = document.body.style.cursor
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
}

function onPointerMove(event: PointerEvent) {
  if (!isDragging || containerStartWidth <= 0) return

  const deltaX = event.clientX - startX
  const newRatio = (startRatio * containerStartWidth + deltaX) / containerStartWidth
  innerRatio.value = clampRatio(newRatio, containerStartWidth)
}

function onPointerUp() {
  if (!isDragging) return

  isDragging = false

  const divider = dividerRef.value
  divider?.removeEventListener('pointermove', onPointerMove)
  divider?.removeEventListener('pointerup', onPointerUp)
  divider?.removeEventListener('pointercancel', onPointerUp)
  divider?.removeEventListener('pointerleave', onPointerUp)

  document.body.style.userSelect = originalUserSelect
  document.body.style.cursor = originalCursor

  emit('update:leftWidth', innerRatio.value)
}

onBeforeUnmount(() => {
  if (isDragging) {
    onPointerUp()
  }
})
</script>

<style scoped>
.rsp-split-pane {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
}

.rsp-left {
  width: calc(var(--left-ratio) * 100%);
  min-width: 0;
  overflow: hidden;
}

.rsp-divider {
  flex-shrink: 0;
  /* 上下留白，让分隔条收在两侧卡片圆角内侧，不再顶到顶部/底部 */
  align-self: center;
  height: calc(100% - 24px);
  width: 6px;
  cursor: col-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-border, #d9d9d9);
  border-radius: 3px;
  touch-action: none;
}

.rsp-divider-handle {
  width: 2px;
  height: 24px;
  border-radius: 1px;
  background: var(--color-text-muted, #999);
}

.rsp-right {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/* 通过 JS matchMedia 同步添加的类，便于单测验证；运行时仍以 CSS 媒体查询为主 */
.rsp-split-pane.is-narrow {
  flex-direction: column;
}

.rsp-split-pane.is-narrow .rsp-left {
  width: 100%;
  flex: none;
}

.rsp-split-pane.is-narrow .rsp-divider {
  display: none;
}

.rsp-split-pane.is-narrow .rsp-right {
  width: 100%;
  flex: 1;
}

@media (max-width: 960px) {
  .rsp-split-pane {
    flex-direction: column;
  }

  .rsp-left {
    width: 100%;
    flex: none;
  }

  .rsp-divider {
    display: none;
  }

  .rsp-right {
    width: 100%;
    flex: 1;
  }
}
</style>
