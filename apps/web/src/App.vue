<template>
  <n-config-provider
    :theme="theme"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-message-provider>
      <n-dialog-provider>
        <n-loading-bar-provider>
          <Layout />
        </n-loading-bar-provider>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  NConfigProvider, NMessageProvider, NDialogProvider, NLoadingBarProvider,
  zhCN, dateZhCN,
} from 'naive-ui'
import Layout from './components/layout/Layout.vue'
import { useTheme } from './composables/useTheme'

const { theme, isDark } = useTheme()

const themeOverrides = computed(() => ({
  common: {
    primaryColor: '#667eea',
    primaryColorHover: '#7c8ff0',
    primaryColorPressed: '#5a67d8',
    primaryColorSuppl: '#667eea',
    borderRadius: '10px',
    fontWeightStrong: '600',
  },
  Card: {
    borderRadius: '16px',
    color: isDark.value ? 'rgba(30, 30, 45, 0.7)' : 'rgba(255, 255, 255, 0.7)',
    borderColor: isDark.value ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.5)',
  },
  Button: { borderRadiusMedium: '10px', borderRadiusSmall: '8px' },
  Input: { borderRadius: '10px' },
  Select: { peers: { InternalSelection: { borderRadius: '10px' } } },
  Drawer: { color: isDark.value ? 'rgba(25, 25, 40, 0.95)' : 'rgba(255, 255, 255, 0.95)' },
  // Modal: { borderRadius: '16px' },
  DataTable: {
    borderRadius: '16px',
    thColor: isDark.value ? 'rgba(40, 40, 60, 0.6)' : 'rgba(250, 250, 250, 0.8)',
    tdColor: isDark.value ? 'rgba(30, 30, 45, 0.5)' : 'rgba(255, 255, 255, 0.6)',
    thColorHover: isDark.value ? 'rgba(50, 50, 70, 0.6)' : 'rgba(240, 240, 240, 0.8)',
    tdColorHover: isDark.value ? 'rgba(40, 40, 60, 0.5)' : 'rgba(250, 250, 250, 0.6)',
  },
  Pagination: { itemBorderRadius: '8px' },
}))
</script>
