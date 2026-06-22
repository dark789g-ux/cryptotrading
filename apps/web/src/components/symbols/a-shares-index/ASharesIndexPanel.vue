<template>
  <div style="padding:24px;color:var(--color-text-secondary)">A 股指数（待实现）</div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesIndexPanel' })
// T7 将覆盖为真实行情表；为保持与 UsIndexPanel 一致的 resize 契约，暴露空 resize
defineExpose({ resize: () => {} })
</script>
