<template>
  <div class="info-row">
    <span class="info-row__label">{{ label }}</span>
    <span class="info-row__value" :class="trend">{{ value }}</span>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'InfoRow' })

withDefaults(
  defineProps<{
    /** 标签文本（含单位，如 "流通市值(亿)"） */
    label: string
    /** 已格式化的值（formatter 处理后的字符串，空值已转 '-'） */
    value: string
    /** 涨跌幅 CSS class：'trend-up' / 'trend-down' / ''。直接取自 aSharesFormatters.trendClass() 返回值，颜色由全局 design-system.css 提供。 */
    trend?: string
  }>(),
  {
    trend: '',
  },
)
</script>

<style scoped>
/* 仅布局：flex 两端对齐 + 字号；trend 颜色由全局 design-system.css 提供（不在组件内重复定义）。 */
.info-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.info-row__label {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.info-row__value {
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.6;
  text-align: right;
}
</style>
