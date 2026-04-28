import { computed } from 'vue'

/** Binance Inspired — 仅浅色模式 */
export function useTheme() {
  const echartsTheme = computed(() => ({
    backgroundColor: 'transparent',
    textStyle: { color: '#848E9C' },
    title: { textStyle: { color: '#D0D4DC' } },
    legend: { textStyle: { color: '#848E9C' } },
    tooltip: {
      backgroundColor: '#2B2F36',
      borderColor: '#3A3F48',
      textStyle: { color: '#D0D4DC' },
    },
    xAxis: {
      axisLine: { lineStyle: { color: '#3A3F48' } },
      axisLabel: { color: '#848E9C' },
      splitLine: { lineStyle: { color: '#3A3F48' } },
    },
    yAxis: {
      axisLine: { lineStyle: { color: '#3A3F48' } },
      axisLabel: { color: '#848E9C' },
      splitLine: { lineStyle: { color: '#3A3F48' } },
    },
    grid: { borderColor: '#3A3F48' },
  }))

  return { echartsTheme }
}
