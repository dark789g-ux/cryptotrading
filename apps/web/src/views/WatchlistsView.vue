<template>
  <div class="watchlists-view workspace-page">
    <watchlist-sidebar />
    <watchlist-table />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useWatchlistStore } from '@/stores/watchlist'
import WatchlistSidebar from '@/components/watchlist/WatchlistSidebar.vue'
import WatchlistTable from '@/components/watchlist/WatchlistTable.vue'

const store = useWatchlistStore()

onMounted(() => {
  store.loadWatchlists()
})
</script>

<style scoped>
.watchlists-view {
  display: flex;
  height: calc(100vh - var(--header-height, 60px));
  overflow: hidden;
}
</style>
