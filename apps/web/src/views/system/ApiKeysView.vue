<script setup lang="ts">
import ApiKeysPanel from '@/components/api-keys/ApiKeysPanel.vue'
</script>

<template>
  <div class="api-keys-view workspace-page workspace-page--narrow">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">API Keys</h1>
    </div>

    <ApiKeysPanel />
  </div>
</template>

<style scoped>
.api-keys-view {
  max-width: 900px;
}
</style>
