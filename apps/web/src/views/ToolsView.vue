<template>
  <div class="tools-view workspace-page">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">工具</h1>
    </div>
    <KellySimulator />
  </div>
</template>

<script setup lang="ts">
import KellySimulator from '../components/tools/KellySimulator.vue'
</script>

<style scoped>
.tools-view {
  max-width: none;
}
</style>
