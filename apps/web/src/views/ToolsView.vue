<template>
  <div class="tools-view workspace-page workspace-page--narrow">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">工具</h1>
    </div>
    <KellyCalculator />
  </div>
</template>

<script setup lang="ts">
import KellyCalculator from '../components/tools/KellyCalculator.vue'
</script>

<style scoped>
.tools-view {
  max-width: 900px;
}
</style>
