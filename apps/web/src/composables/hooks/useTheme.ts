import { computed } from 'vue'
import { colors } from '../../styles/tokens'

/** Binance Inspired — 仅浅色模式 */
export function useTheme() {
  const echartsTheme = computed(() => ({
    backgroundColor: 'transparent',
    textStyle: { color: colors.text.secondary },
    title: { textStyle: { color: colors.text.DEFAULT } },
    legend: { textStyle: { color: colors.text.secondary } },
    tooltip: {
      backgroundColor: colors.surface.elevated,
      borderColor: colors.border.DEFAULT,
      textStyle: { color: colors.text.DEFAULT },
    },
    xAxis: {
      axisLine: { lineStyle: { color: colors.border.DEFAULT } },
      axisLabel: { color: colors.text.secondary },
      splitLine: { lineStyle: { color: colors.border.DEFAULT } },
    },
    yAxis: {
      axisLine: { lineStyle: { color: colors.border.DEFAULT } },
      axisLabel: { color: colors.text.secondary },
      splitLine: { lineStyle: { color: colors.border.DEFAULT } },
    },
    grid: { borderColor: colors.border.DEFAULT },
  }))

  return { echartsTheme }
}
