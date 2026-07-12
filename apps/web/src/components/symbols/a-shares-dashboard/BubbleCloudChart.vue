<template>
  <div ref="containerRef" class="bubble-cloud-chart">
    <!-- Loading 态 -->
    <div v-if="loading" class="bubble-cloud-chart__overlay">
      <span class="bubble-cloud-chart__overlay-text">加载中...</span>
    </div>

    <!-- Empty 态 -->
    <div v-else-if="!layoutResult.nodes.length" class="bubble-cloud-chart__overlay">
      <span class="bubble-cloud-chart__overlay-text">暂无数据</span>
    </div>

    <!-- SVG 气泡图 -->
    <div v-else class="bubble-cloud-chart__svg-wrap" :style="svgWrapStyle">
      <svg
        ref="svgRef"
        :width="svgWidth"
        :height="svgHeight"
        xmlns="http://www.w3.org/2000/svg"
      >
        <!-- 中线 0 基准 -->
        <line
          :x1="0"
          :y1="svgHeight / 2"
          :x2="svgWidth"
          :y2="svgHeight / 2"
          stroke="#3A3F48"
          stroke-width="1"
          stroke-dasharray="6 4"
        />
        <text
          :x="svgWidth - 6"
          :y="svgHeight / 2 - 6"
          fill="#686A6C"
          font-size="11"
          text-anchor="end"
        >
          0 基准
        </text>

        <!-- 气泡 -->
        <g
          v-for="node in layoutResult.nodes"
          :key="node.id"
          class="bubble-group"
          @click="handleClick(node)"
        >
          <circle
            :cx="node.x"
            :cy="node.y"
            :r="node.r"
            :fill="node.value > 0 ? fillColorPositive : fillColorNegative"
            :stroke="node.value > 0 ? strokeColorPositive : strokeColorNegative"
            stroke-width="1.5"
            class="bubble-circle"
          />
          <!-- 板块名 -->
          <text
            v-if="node.r >= 14"
            :x="node.x"
            :y="node.y + (node.r >= 18 ? -4 : 0)"
            text-anchor="middle"
            dominant-baseline="central"
            fill="#fff"
            :font-size="node.r >= 22 ? 12 : 10"
            pointer-events="none"
            class="bubble-text"
          >
            {{ node.name }}
          </text>
          <!-- 净额 -->
          <text
            v-if="node.r >= 18"
            :x="node.x"
            :y="node.y + 10"
            text-anchor="middle"
            dominant-baseline="central"
            fill="#fff"
            :font-size="node.r >= 28 ? 12 : 10"
            pointer-events="none"
            class="bubble-text"
          >
            {{ formatValue(node.value) }}
          </text>
        </g>
      </svg>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { layoutBubbles } from './bubbleLayout'
import type { BubbleInputNode, BubbleLayoutResult } from './bubbleLayout'

// ---------------------------------------------------------------------------
// Props & Emits
// ---------------------------------------------------------------------------

const props = withDefaults(defineProps<{
  nodes: BubbleInputNode[]
  loading?: boolean
}>(), {
  loading: false,
})

const emit = defineEmits<{
  'bubble-click': [payload: { tsCode: string; name: string; value: number }]
}>()

// ---------------------------------------------------------------------------
// 颜色常量
// ---------------------------------------------------------------------------
// 绿色 = 净流入（正值），红色 = 净流出（负值）
const fillColorPositive = 'rgba(14, 203, 129, 0.25)'
const strokeColorPositive = '#0ECB81'
const fillColorNegative = 'rgba(246, 70, 93, 0.25)'
const strokeColorNegative = '#F6465D'

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

const containerRef = ref<HTMLElement | null>(null)
const svgRef = ref<SVGElement | null>(null)

/** 容器当前尺寸 */
const containerSize = ref({ width: 0, height: 0 })

/** 布局结果 */
const layoutResult = ref<BubbleLayoutResult>({ nodes: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } })

// ---------------------------------------------------------------------------
// ResizeObserver
// ---------------------------------------------------------------------------

let resizeObserver: ResizeObserver | null = null

function setupResizeObserver() {
  if (!containerRef.value) return

  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) {
        containerSize.value = { width, height }
      }
    }
  })

  resizeObserver.observe(containerRef.value)
}

onMounted(() => {
  setupResizeObserver()
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// ---------------------------------------------------------------------------
// 布局计算
// ---------------------------------------------------------------------------

function computeLayout() {
  if (!props.nodes.length) {
    layoutResult.value = { nodes: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }
    return
  }

  layoutResult.value = layoutBubbles(props.nodes, {
    width: containerSize.value.width,
    height: containerSize.value.height,
    minRadius: 22,
    maxRadius: 70,
  })
}

// 容器尺寸变化 → 重新布局
watch(containerSize, () => {
  computeLayout()
})

// props.nodes 变化 → 重新布局
watch(() => props.nodes, () => {
  computeLayout()
}, { deep: true })

// ---------------------------------------------------------------------------
// SVG 尺寸
// ---------------------------------------------------------------------------

const svgWidth = computed(() => {
  if (!layoutResult.value.nodes.length) return 0
  return Math.max(containerSize.value.width, layoutResult.value.bounds.maxX)
})

const svgHeight = computed(() => {
  if (!layoutResult.value.nodes.length) return 0
  return Math.max(containerSize.value.height, layoutResult.value.bounds.maxY)
})

const svgWrapStyle = computed(() => ({
  overflow: 'auto' as const,
}))

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

function formatValue(v: number): string {
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(1)}亿`
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

function handleClick(node: BubbleInputNode) {
  emit('bubble-click', {
    tsCode: node.id,
    name: node.name,
    value: node.value,
  })
}
</script>

<style scoped>
.bubble-cloud-chart {
  width: 100%;
  height: 420px;
  min-height: 300px;
  position: relative;
  background: #222126;
  border-radius: 8px;
  overflow: hidden;
}

.bubble-cloud-chart__svg-wrap {
  width: 100%;
  height: 100%;
}

.bubble-cloud-chart__overlay {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.bubble-cloud-chart__overlay-text {
  color: #848E9C;
  font-size: 14px;
}

/* 气泡交互效果 */
.bubble-group {
  cursor: pointer;
}

.bubble-circle {
  transition: transform 0.15s ease, stroke-width 0.15s ease;
  transform-origin: center;
  transform-box: fill-box;
}

.bubble-group:hover .bubble-circle {
  transform: scale(1.05);
  stroke-width: 2.5;
}

.bubble-text {
  user-select: none;
  pointer-events: none;
}
</style>
