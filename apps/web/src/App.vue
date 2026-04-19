<template>
  <n-config-provider
    :theme="null"
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
import {
  NConfigProvider, NMessageProvider, NDialogProvider, NLoadingBarProvider,
  zhCN, dateZhCN,
} from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import Layout from './components/layout/Layout.vue'

const themeOverrides: GlobalThemeOverrides = {
  common: {
    // Ember Studio 主色
    primaryColor: '#C2410C',
    primaryColorHover: '#9A3412',
    primaryColorPressed: '#7C2D12',
    primaryColorSuppl: '#C2410C',
    // 信息色 — 用中性色
    infoColor: '#78716C',
    infoColorHover: '#57534E',
    infoColorPressed: '#44403C',
    // 语义色
    successColor: '#16A34A',
    successColorHover: '#15803D',
    successColorPressed: '#166534',
    warningColor: '#D97706',
    warningColorHover: '#B45309',
    warningColorPressed: '#92400E',
    errorColor: '#DC2626',
    errorColorHover: '#B91C1C',
    errorColorPressed: '#991B1B',
    // 字体
    fontFamily: "'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontWeightStrong: '600',
    fontSize: '16px',
    // 圆角
    borderRadius: '8px',
    borderRadiusSmall: '4px',
    // 颜色基础
    bodyColor: '#FAFAF9',
    cardColor: '#F5F5F4',
    modalColor: '#FAFAF9',
    popoverColor: '#FAFAF9',
    tableColor: '#F5F5F4',
    inputColor: '#F5F5F4',
    actionColor: '#F5F5F4',
    hoverColor: '#E7E5E4',
    borderColor: '#D6D3D1',
    dividerColor: '#D6D3D1',
    textColorBase: '#1C1917',
    textColor1: '#1C1917',
    textColor2: '#57534E',
    textColor3: '#78716C',
    placeholderColor: '#A8A29E',
  },
  Card: {
    borderRadius: '12px',
    color: '#F5F5F4',
    borderColor: '#D6D3D1',
    titleFontWeight: '700',
    titleFontSizeMedium: '20px',
  },
  Button: {
    borderRadiusMedium: '8px',
    borderRadiusSmall: '8px',
    borderRadiusLarge: '8px',
    fontWeightStrong: '600',
    fontWeight: '600',
  },
  Input: {
    borderRadius: '8px',
    color: '#F5F5F4',
    fontSizeMedium: '16px',
  },
  Select: {
    peers: {
      InternalSelection: {
        borderRadius: '8px',
        color: '#F5F5F4',
      },
    },
  },
  Drawer: {
    color: '#FAFAF9',
  },
  Modal: {
    color: '#FAFAF9',
  },
  DataTable: {
    borderRadius: '12px',
    thColor: '#F5F5F4',
    tdColor: '#FAFAF9',
    thColorHover: '#E7E5E4',
    tdColorHover: '#F5F5F4',
    borderColor: '#D6D3D1',
    thFontWeight: '600',
  },
  Pagination: {
    itemBorderRadius: '8px',
  },
  Tag: {
    borderRadius: '9999px',
  },
  Menu: {
    borderRadius: '8px',
    itemColorActive: 'rgba(194, 65, 12, 0.08)',
    itemColorActiveHover: 'rgba(194, 65, 12, 0.12)',
    itemTextColorActive: '#C2410C',
    itemTextColorActiveHover: '#C2410C',
    itemIconColorActive: '#C2410C',
    itemIconColorActiveHover: '#C2410C',
    itemColorHover: '#E7E5E4',
  },
  Tabs: {
    tabTextColorActiveLine: '#C2410C',
    tabTextColorHoverLine: '#9A3412',
    barColor: '#C2410C',
  },
}
</script>
