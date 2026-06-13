import { onBeforeUnmount, onMounted } from 'vue'

// 鼠标位于 n-data-table 上、按住 Shift 滚动滚轮时，把竖向滚轮增量转成水平滚动，
// 驱动表格最近的可横向滚动祖先（视图容器 / main-content）。全站宽表统一生效。
// 依赖 Layout 已让内容区可横向滚动（.main-shell min-width:0 + .main-content overflow-x:auto）。

function findHorizontalScroller(start: Element | null): HTMLElement | null {
  let el: Element | null = start
  while (el && el !== document.body) {
    if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth) {
      const overflowX = getComputedStyle(el).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll') return el
    }
    el = el.parentElement
  }
  return null
}

export function useShiftWheelHScroll() {
  function onWheel(e: WheelEvent) {
    if (!e.shiftKey) return
    const target = e.target
    if (!(target instanceof Element)) return
    // 仅当滚轮落在数据表内时接管
    if (!target.closest('.n-data-table')) return
    // 部分浏览器在按住 Shift 时已把增量给到 deltaX，这里两路都取
    const delta = e.deltaY || e.deltaX
    if (!delta) return
    const scroller = findHorizontalScroller(target)
    if (!scroller) return
    // 自己横向滚，并阻止默认（避免与原生 Shift 横滚叠加成双倍）
    e.preventDefault()
    scroller.scrollLeft += delta
  }

  onMounted(() => window.addEventListener('wheel', onWheel, { passive: false }))
  onBeforeUnmount(() => window.removeEventListener('wheel', onWheel))
}
