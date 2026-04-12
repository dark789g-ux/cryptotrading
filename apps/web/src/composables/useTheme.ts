import { ref, computed } from 'vue'
import { darkTheme, lightTheme } from 'naive-ui'

const STORAGE_KEY = 'cryptotrading-theme'
const isDark = ref(localStorage.getItem(STORAGE_KEY) !== 'light')

function updateDocumentTheme() {
  if (isDark.value) {
    document.documentElement.classList.add('dark')
    document.documentElement.classList.remove('light')
  } else {
    document.documentElement.classList.add('light')
    document.documentElement.classList.remove('dark')
  }
}

export function useTheme() {
  const theme = computed(() => isDark.value ? darkTheme : lightTheme)

  const toggleTheme = () => {
    isDark.value = !isDark.value
    localStorage.setItem(STORAGE_KEY, isDark.value ? 'dark' : 'light')
    updateDocumentTheme()
  }

  const echartsTheme = computed(() => ({
    backgroundColor: 'transparent',
    textStyle: { color: isDark.value ? '#e0e0e0' : '#333333' },
    title: { textStyle: { color: isDark.value ? '#ffffff' : '#1a1a1a' } },
    legend: { textStyle: { color: isDark.value ? '#e0e0e0' : '#333333' } },
    tooltip: {
      backgroundColor: isDark.value ? 'rgba(30,30,40,0.9)' : 'rgba(255,255,255,0.95)',
      borderColor: isDark.value ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
      textStyle: { color: isDark.value ? '#e0e0e0' : '#333333' },
    },
    xAxis: {
      axisLine: { lineStyle: { color: isDark.value ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' } },
      axisLabel: { color: isDark.value ? '#a0a0a0' : '#666666' },
      splitLine: { lineStyle: { color: isDark.value ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' } },
    },
    yAxis: {
      axisLine: { lineStyle: { color: isDark.value ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' } },
      axisLabel: { color: isDark.value ? '#a0a0a0' : '#666666' },
      splitLine: { lineStyle: { color: isDark.value ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' } },
    },
    grid: { borderColor: isDark.value ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' },
  }))

  updateDocumentTheme()
  return { isDark, theme, echartsTheme, toggleTheme }
}
