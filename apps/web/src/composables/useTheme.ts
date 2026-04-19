import { computed } from 'vue'

/** Ember Studio — 仅浅色模式 */
export function useTheme() {
  const echartsTheme = computed(() => ({
    backgroundColor: 'transparent',
    textStyle: { color: '#57534E' },
    title: { textStyle: { color: '#1C1917' } },
    legend: { textStyle: { color: '#57534E' } },
    tooltip: {
      backgroundColor: '#FAFAF9',
      borderColor: '#D6D3D1',
      textStyle: { color: '#1C1917' },
    },
    xAxis: {
      axisLine: { lineStyle: { color: '#D6D3D1' } },
      axisLabel: { color: '#78716C' },
      splitLine: { lineStyle: { color: '#E7E5E4' } },
    },
    yAxis: {
      axisLine: { lineStyle: { color: '#D6D3D1' } },
      axisLabel: { color: '#78716C' },
      splitLine: { lineStyle: { color: '#E7E5E4' } },
    },
    grid: { borderColor: '#D6D3D1' },
  }))

  return { echartsTheme }
}
