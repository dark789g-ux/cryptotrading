/**
 * 气泡云「行式分层」布局算法 (pure function, no Vue dependency)
 *
 * 设计目标：
 * 1. 绝不重叠（硬约束，数学保证圆心距 ≥ 半径和 + gap）
 * 2. 大球靠近中线、小球远离中线（按半径在组内降序后逐行堆叠）
 *
 * 算法（两阶段，保证行间距正确）：
 * - 数据按 value 正负分两组（正=净流入上半区，负=净流出下半区）
 * - 每组内按半径降序排列，从紧邻中线开始逐行向外铺：
 *   第 1 行最靠近中线（最大的球），第 2 行更远（中等球）……
 * - 阶段一「分行」：按宽度贪心，塞不下即换行；记录每行 maxR
 * - 阶段二「定位」：行间距 = 上行 maxR + gap + 本行 maxR（保证行间不重叠）；
 *   同行内 x 步进 = 左球 r + gap + 当前 r（保证同行不重叠）
 *
 * 时间复杂度 O(n)。
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BubbleInputNode {
  /** 唯一标识（ts_code） */
  id: string
  /** 板块名（如 "创新药"） */
  name: string
  /** 净流入额（亿元，有正负） */
  value: number
  /** 涨跌幅 %，布局中不使用，透传给结果 */
  pctChange: number | null
}

export interface BubbleNode extends BubbleInputNode {
  /** 圆心 x（相对容器左上角，像素） */
  x: number
  /** 圆心 y（像素） */
  y: number
  /** 半径（像素） */
  r: number
}

export interface BubbleLayoutResult {
  nodes: BubbleNode[]
  /** 布局实际占用边界，供 SVG 尺寸计算 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export interface BubbleLayoutOptions {
  /** 容器宽 */
  width: number
  /** 容器高 */
  height: number
  /** 最小半径，默认 22 */
  minRadius?: number
  /** 最大半径，默认 70 */
  maxRadius?: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const GAP = 4 // 气泡间距（像素）

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * 将 value 映射为气泡半径。sqrt 让小值不会太小，保持视觉辨识度。
 */
function mapRadius(value: number, maxAbs: number, minR: number, maxR: number): number {
  if (maxAbs === 0) return minR
  const ratio = Math.sqrt(Math.abs(value) / maxAbs)
  return clamp(minR + (maxR - minR) * ratio, minR, maxR)
}

/** 一行气泡（分行阶段的中间结构） */
interface Row {
  /** 该行包含的 {节点索引, 半径} */
  items: { idx: number; r: number }[]
  /** 该行最大半径（决定行高与行间距） */
  maxR: number
}

// ---------------------------------------------------------------------------
// 行式分层放置（单组核心算法，两阶段）
// ---------------------------------------------------------------------------

/**
 * 将一组（已按半径降序）的球逐行铺向远离中线的方向，返回带坐标的放置结果。
 *
 * @param group      按半径降序排列的输入节点（大球在前）
 * @param radiusMap  每个节点对应的半径
 * @param startBaseY 第一行基准 y（紧邻中线那一侧）
 * @param direction  远离中线的方向：-1 向上（正组，y 减小），+1 向下（负组，y 增大）
 * @param width      容器宽（行内水平塞不下即换行）
 * @returns          { idx, x, y, r } 列表（idx 对应 group 中的下标）
 */
function packRows(
  group: BubbleInputNode[],
  radiusMap: number[],
  startBaseY: number,
  direction: -1 | 1,
  width: number,
): { idx: number; x: number; y: number; r: number }[] {
  // ---------- 阶段一：按宽度贪心分行 ----------
  const rows: Row[] = []
  for (let i = 0; i < group.length; i++) {
    const r = radiusMap[i]
    const last = rows[rows.length - 1]
    // 尝试塞进末行：估算末行已占宽度 = 末行各球直径之和 + gap*(n-1)，
    // 加上当前球直径 + gap 后不越 width 才塞入。
    const fitsLast = last && canFitInRow(last, r, width)
    if (fitsLast) {
      last.items.push({ idx: i, r })
      last.maxR = Math.max(last.maxR, r)
    } else {
      rows.push({ items: [{ idx: i, r }], maxR: r })
    }
  }

  // ---------- 阶段二：按相邻行 maxR 之和精确定位 baseY ----------
  // 第 1 行 baseY = startBaseY；
  // 第 k 行 baseY = 第 k-1 行 baseY + direction * (上行 maxR + gap + 本行 maxR)。
  // 这样无论本行后续是否出现更大球，行间距都按「已知的两行各自 maxR」算定，
  // 数学上保证任意相邻两行最近球对的圆心距 ≥ 上行 maxR + gap + 本行 maxR，
  // 即圆缘间距 ≥ gap，不重叠。
  let runningBaseY = startBaseY
  const results: { idx: number; x: number; y: number; r: number }[] = []
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]
    if (ri > 0) {
      const prev = rows[ri - 1]
      runningBaseY += direction * (prev.maxR + GAP + row.maxR)
    }
    // 行内 x 步进：左缘对齐，x[0] = row.items[0].r；
    // 后续 x = 上球 x + 上球 r + gap + 当前 r，保证同行不重叠。
    let x = row.items[0].r
    for (let j = 0; j < row.items.length; j++) {
      const it = row.items[j]
      if (j === 0) {
        x = it.r
      } else {
        const prevR = row.items[j - 1].r
        x = x + prevR + GAP + it.r
      }
      results.push({ idx: it.idx, x, y: runningBaseY, r: it.r })
    }
  }

  return results
}

/** 末行加入半径 r 的新球后，右缘是否仍在 width 内 */
function canFitInRow(row: Row, r: number, width: number): boolean {
  // 已占宽度（圆缘到圆缘）：第一个球左缘起算，到末球右缘。
  // 用累加：x_0 = items[0].r；x_k = x_{k-1} + prevR + gap + r_k；右缘 = x_last + r_last。
  let x = row.items[0].r
  for (let j = 1; j < row.items.length; j++) {
    const prevR = row.items[j - 1].r
    x = x + prevR + GAP + row.items[j].r
  }
  // 末球右缘
  const lastR = row.items[row.items.length - 1].r
  const rightEdge = x + lastR
  // 加入新球后右缘
  const newRightEdge = rightEdge + GAP + r + r // gap + 新球直径
  return newRightEdge <= width
}

// ---------------------------------------------------------------------------
// Main layout function
// ---------------------------------------------------------------------------

/**
 * 对输入节点执行行式分层布局。
 *
 * @param nodes   输入节点（含 id, name, value, pctChange）
 * @param options 容器尺寸与半径范围
 * @returns 布局结果（节点坐标 + 外接边界）
 */
export function layoutBubbles(
  nodes: BubbleInputNode[],
  options: BubbleLayoutOptions,
): BubbleLayoutResult {
  const { width, height, minRadius = 22, maxRadius = 70 } = options

  // ---------- 1. 分组（displayNodes 已按 |value| 降序传入，二次排序做防御） ----------
  const positives = nodes
    .filter(n => n.value > 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
  const negatives = nodes
    .filter(n => n.value < 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
  // value === 0 的丢弃

  const allNodes = [...positives, ...negatives]
  if (allNodes.length === 0) {
    return { nodes: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }
  }

  // ---------- 2. 半径映射 ----------
  const maxAbs = Math.max(...allNodes.map(n => Math.abs(n.value)), 1)
  const posRadii = positives.map(n => mapRadius(n.value, maxAbs, minRadius, maxRadius))
  const negRadii = negatives.map(n => mapRadius(n.value, maxAbs, minRadius, maxRadius))

  // ---------- 3. 行式分层放置 ----------
  // 中线 y = height/2。每组第一行紧邻中线（留 maxR + gap 间距）。
  const midY = height / 2
  const posFirstR = posRadii.length > 0 ? posRadii[0] : minRadius
  const negFirstR = negRadii.length > 0 ? negRadii[0] : minRadius
  // 正组在中线上方（第一行最大球，圆心离中线 = firstR + gap）
  const posStartBaseY = midY - GAP - posFirstR
  // 负组在中线下方
  const negStartBaseY = midY + GAP + negFirstR

  const posPlaced = packRows(positives, posRadii, posStartBaseY, -1, width)
  const negPlaced = packRows(negatives, negRadii, negStartBaseY, 1, width)

  // ---------- 4. 组装结果（按原 idx 回填节点信息） ----------
  const result: BubbleNode[] = []
  for (const p of posPlaced) {
    result.push({ ...positives[p.idx], x: p.x, y: p.y, r: p.r })
  }
  for (const p of negPlaced) {
    result.push({ ...negatives[p.idx], x: p.x, y: p.y, r: p.r })
  }

  // ---------- 5. 外接边界 ----------
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of result) {
    minX = Math.min(minX, n.x - n.r)
    minY = Math.min(minY, n.y - n.r)
    maxX = Math.max(maxX, n.x + n.r)
    maxY = Math.max(maxY, n.y + n.r)
  }

  return { nodes: result, bounds: { minX, minY, maxX, maxY } }
}
