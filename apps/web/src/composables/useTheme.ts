import { computed } from 'vue'

/** Binance Inspired — 仅浅色模式 */
export function useTheme() {
  const echartsTheme = computed(() => ({
    backgroundColor: 'transparent',
    textStyle: { color: '#848E9C' },
    title: { textStyle: { color: '#1E2026' } },
    legend: { textStyle: { color: '#848E9C' } },
    tooltip: {
      backgroundColor: '#FFFFFF',
      borderColor: '#E6E8EA',
      textStyle: { color: '#1E2026' },
    },
    xAxis: {
      axisLine: { lineStyle: { color: '#E6E8EA' } },
      axisLabel: { color: '#848E9C' },
      splitLine: { lineStyle: { color: '#F5F5F5' } },
    },
    yAxis: {
      axisLine: { lineStyle: { color: '#E6E8EA' } },
      axisLabel: { color: '#848E9C' },
      splitLine: { lineStyle: { color: '#F5F5F5' } },
    },
    grid: { borderColor: '#E6E8EA' },
  }))

  return { echartsTheme }
}
