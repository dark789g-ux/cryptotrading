import { ref } from 'vue'

export type SymbolsViewMode = 'table' | 'split'
export type SymbolsPanelScope = 'crypto' | 'aShares' | 'usStocks'

const VIEW_MODE_KEY = (scope: SymbolsPanelScope) => `symbols_panel_view_mode_${scope}`

/**
 * 读 localStorage 中持久化的视图模式；非法 / 不可用 → 默认 'table'。
 * 与 SymbolsPanelLayout 内部 fallback 逻辑同名 key、同默认值，
 * 让 Panel 持有的 viewMode 与 Layout 未受控时的兜底初值保持一致。
 */
function readValidViewMode(scope: SymbolsPanelScope): SymbolsViewMode {
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY(scope))
    if (raw === 'table' || raw === 'split') return raw
  } catch {
    /* localStorage 可能不可用（隐私模式 / 配额） */
  }
  return 'table'
}

/**
 * 标的面板的视图模式（表格 / 分栏）状态。
 *
 * 设计：Panel 通过本 composable 持有 viewMode ref 并 v-model 给 SymbolsPanelLayout。
 * Layout 自身仍保留未受控时的 fallback（见 SymbolsPanelLayout.vue），两者通过同名
 * localStorage key + 同默认值协同，初值一致、互不覆盖。
 *
 * 切换由 Layout 内部的 toggleViewMode 完成（其 set 无条件 persistViewMode + emit），
 * 故本 composable 只负责持有初始值，不暴露 setter / 不重复 persist。
 */
export function usePanelViewMode(scope: SymbolsPanelScope) {
  const viewMode = ref<SymbolsViewMode>(readValidViewMode(scope))
  return { viewMode }
}
