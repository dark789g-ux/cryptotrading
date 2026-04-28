import { ref, watch } from 'vue'

const STORAGE_KEY = 'sidebar-collapsed'

const isCollapsed = ref(localStorage.getItem(STORAGE_KEY) === 'true')

watch(isCollapsed, (val) => {
  localStorage.setItem(STORAGE_KEY, String(val))
})

window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    isCollapsed.value = e.newValue === 'true'
  }
})

export function useSidebarCollapsed() {
  const toggle = () => {
    isCollapsed.value = !isCollapsed.value
  }
  return { isCollapsed, toggle }
}
