/**
 * 大盘宽基候选噪声标签的展示映射（颜色 + 文案）。
 *
 * 颜色约定（spec 04 §4.3）：delisted 红 / cross_border 黄 / total_return 灰 / duplicate 蓝 / small_cap 默认。
 * 与后端 classifyNoise.NoiseTag 一一对应（镜像自 api/modules/marketIndexScope 的 MarketIndexNoiseTag）。
 */
import type { MarketIndexNoiseTag } from '@/api'

export interface NoiseTagDisplay {
  /** n-tag type，控制颜色。 */
  type: 'error' | 'warning' | 'default' | 'info'
  /** 展示文案。 */
  label: string
}

/** 单标签 → 展示。 */
const NOISE_TAG_DISPLAY: Record<MarketIndexNoiseTag, NoiseTagDisplay> = {
  delisted: { type: 'error', label: '已退市' },
  cross_border: { type: 'warning', label: '跨境/外币' },
  total_return: { type: 'default', label: '收益版' },
  duplicate: { type: 'info', label: '次挂牌' },
  small_cap: { type: 'default', label: '中小盘' },
}

/** 把一组噪声标签映射为展示信息（保持原顺序）。 */
export function displayNoiseTags(tags: MarketIndexNoiseTag[]): NoiseTagDisplay[] {
  return tags.map((t) => NOISE_TAG_DISPLAY[t])
}
