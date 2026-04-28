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
          <Layout v-if="!route.meta.authPage" />
          <router-view v-else />
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
import { useRoute } from 'vue-router'
import Layout from './components/layout/Layout.vue'
import { colors } from './styles/tokens'

const route = useRoute()

const themeOverrides: GlobalThemeOverrides = {
  common: {
    // 主色
    primaryColor: colors.primary.DEFAULT,
    primaryColorHover: colors.primary.hover,
    primaryColorPressed: colors.primary.pressed,
    primaryColorSuppl: colors.primary.suppl,
    // 信息色
    infoColor: colors.info.DEFAULT,
    infoColorHover: colors.info.hover,
    infoColorPressed: colors.info.pressed,
    // 语义色 — 国际惯例：绿涨红跌
    successColor: colors.success.DEFAULT,
    successColorHover: colors.success.hover,
    successColorPressed: colors.success.pressed,
    warningColor: colors.warning.DEFAULT,
    warningColorHover: colors.warning.hover,
    warningColorPressed: colors.warning.pressed,
    errorColor: colors.error.DEFAULT,
    errorColorHover: colors.error.hover,
    errorColorPressed: colors.error.pressed,
    // 字体
    fontFamily: "Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontWeightStrong: '700',
    fontSize: '16px',
    // 圆角
    borderRadius: '6px',
    borderRadiusSmall: '4px',
    // 颜色基础
    bodyColor: colors.surface.DEFAULT,
    cardColor: colors.surface.DEFAULT,
    modalColor: colors.surface.DEFAULT,
    popoverColor: colors.surface.DEFAULT,
    tableColor: colors.surface.DEFAULT,
    inputColor: colors.surface.elevated,
    actionColor: colors.surface.elevated,
    hoverColor: colors.surface.elevated,
    borderColor: colors.border.DEFAULT,
    dividerColor: colors.border.DEFAULT,
    textColorBase: colors.text.DEFAULT,
    textColor1: colors.text.DEFAULT,
    textColor2: colors.text.secondary,
    textColor3: colors.text.muted,
    placeholderColor: colors.text.muted,
  },
  Card: {
    borderRadius: '12px',
    color: colors.surface.elevated,
    borderColor: colors.border.DEFAULT,
    titleFontWeight: '700',
    titleFontSizeMedium: '20px',
  },
  Button: {
    borderRadiusMedium: '6px',
    borderRadiusSmall: '6px',
    borderRadiusLarge: '6px',
    fontWeightStrong: '600',
    fontWeight: '600',
  },
  Input: {
    borderRadius: '8px',
    color: colors.surface.DEFAULT,
    fontSizeMedium: '16px',
    borderHover: `1px solid ${colors.border.DEFAULT}`,
    borderFocus: `1px solid ${colors.black}`,
    boxShadowFocus: `0 0 0 1px ${colors.black}`,
  },
  Select: {
    peers: {
      InternalSelection: {
        borderRadius: '8px',
        color: colors.surface.DEFAULT,
        borderHover: `1px solid ${colors.border.DEFAULT}`,
        borderActive: `1px solid ${colors.black}`,
        boxShadowActive: `0 0 0 1px ${colors.black}`,
        boxShadowFocus: `0 0 0 1px ${colors.black}`,
      },
    },
  },
  Drawer: {
    color: colors.surface.DEFAULT,
  },
  Modal: {
    color: colors.surface.DEFAULT,
    boxShadow: `0 24px 48px ${colors.ink}1f`,
  },
  DataTable: {
    borderRadius: '12px',
    thColor: colors.surface.elevated,
    tdColor: colors.surface.DEFAULT,
    thColorHover: colors.surface.elevated,
    tdColorHover: colors.surface.elevated,
    thColorSorting: colors.surface.elevated,
    tdColorSorting: colors.surface.elevated,
    thColorSortingModal: colors.surface.elevated,
    tdColorSortingModal: colors.surface.elevated,
    thColorSortingPopover: colors.surface.elevated,
    tdColorSortingPopover: colors.surface.elevated,
    borderColor: colors.border.DEFAULT,
    thTextColor: colors.text.secondary,
    thIconColor: colors.text.muted,
    thIconColorActive: colors.primary.DEFAULT,
    thFontWeight: '600',
  },
  Pagination: {
    itemBorderRadius: '6px',
    buttonColor: 'transparent',
    buttonColorHover: colors.surface.elevated,
    buttonColorPressed: colors.surface.elevated,
    buttonBorder: `1px solid ${colors.border.DEFAULT}`,
    buttonBorderHover: `1px solid ${colors.border.DEFAULT}`,
    buttonBorderPressed: `1px solid ${colors.border.DEFAULT}`,
    buttonIconColor: colors.text.secondary,
    buttonIconColorHover: colors.text.DEFAULT,
    buttonIconColorPressed: colors.text.DEFAULT,
    itemTextColor: colors.text.secondary,
    itemTextColorHover: colors.text.DEFAULT,
    itemTextColorPressed: colors.text.DEFAULT,
    itemTextColorActive: colors.primary.DEFAULT,
    itemTextColorDisabled: colors.text.muted,
    itemColorHover: colors.surface.elevated,
    itemColorPressed: colors.surface.elevated,
    itemColorDisabled: colors.surface.elevated,
    itemBorderActive: `1px solid ${colors.primary.DEFAULT}`,
    itemBorderDisabled: `1px solid ${colors.border.DEFAULT}`,
    jumperTextColor: colors.text.secondary,
    jumperTextColorDisabled: colors.text.muted,
  },
  Tag: {
    borderRadius: '9999px',
  },
  Menu: {
    borderRadius: '6px',
    /* 未选中态 — 深色 sidebar 上的浅色文字 */
    itemTextColor: colors.text.onDark,
    itemTextColorHover: colors.surface.DEFAULT,
    itemIconColor: colors.text.onDark,
    itemIconColorHover: colors.surface.DEFAULT,
    /* 选中态 — 深灰底 + 黄字 + 黄边框 */
    itemColorActive: colors.surface.darkCard,
    itemColorActiveHover: colors.surface.darkCard,
    itemTextColorActive: colors.primary.DEFAULT,
    itemTextColorActiveHover: colors.primary.DEFAULT,
    itemIconColorActive: colors.primary.DEFAULT,
    itemIconColorActiveHover: colors.primary.DEFAULT,
    /* Hover 背景 */
    itemColorHover: colors.surface.darkCard,
  },
  Tabs: {
    tabTextColorActiveLine: colors.primary.DEFAULT,
    tabTextColorHoverLine: colors.primary.hover,
    barColor: colors.primary.DEFAULT,
  },
}
</script>
