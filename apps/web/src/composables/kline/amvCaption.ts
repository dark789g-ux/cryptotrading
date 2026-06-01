/**
 * 活跃市值（AMV，副图 key `0AMV` / `0AMV_MACD`）的合规标注文案。
 *
 * 集中两处文案，供个股（AShareDetailDrawer）与行业（FlowTrendModal）视图复用，
 * 避免措辞散落漂移。依据 spec
 * `docs/superpowers/specs/2026-06-01-active-mv-stock-industry-design.md` §8、§11：
 * - 信号未回测校准（个股 + 行业都需标注）；
 * - 行业量基于成分股「当前快照」、无历史成分（PIT 缺失，仅行业视图追加）。
 *
 * 仅作纯展示文案，不参与任何副图渲染 / 交互逻辑。
 */

/** 第 1 条：信号未回测校准（个股 + 行业通用） */
export const AMV_CAPTION_BASE =
  '0AMV 为活跃市值指标，信号未回测校准，仅供参考'

/** 第 2 条：行业量基于成分股当前快照（仅行业视图追加） */
export const AMV_CAPTION_INDUSTRY_SNAPSHOT =
  '行业量基于成分股当前快照，无历史成分，回溯存在成分漂移'

/** 行业视图完整标注 = 第 1 条 + 第 2 条 */
export const AMV_CAPTION_INDUSTRY =
  `${AMV_CAPTION_BASE}；${AMV_CAPTION_INDUSTRY_SNAPSHOT}`
