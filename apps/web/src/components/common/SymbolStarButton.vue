<template>
  <n-popover
    trigger="click"
    placement="bottom"
    :show-arrow="false"
    style="padding: 0"
    @update:show="handleShowChange"
  >
    <template #trigger>
      <n-button text style="font-size: 16px" :loading="loading">
        <n-icon :component="isStarred ? Star : StarOutline" :color="isStarred ? '#f0a020' : undefined" />
      </n-button>
    </template>

    <div class="star-popover-content">
      <div class="star-popover-header">选择自选列表</div>
      <n-spin v-if="loading" size="small" />
      <n-empty v-else-if="!watchlists.length" description="暂无列表" size="small" />
      <div v-else class="star-popover-list">
        <n-checkbox
          v-for="wl in watchlists"
          :key="wl.id"
          :checked="isInWatchlist(wl)"
          :disabled="toggling[wl.id]"
          @update:checked="(checked: boolean) => toggle(wl.id, checked)"
        >
          <span class="star-popover-label">{{ wl.name }}</span>
          <span class="star-popover-count">({{ wl.items?.length ?? 0 }})</span>
        </n-checkbox>
      </div>
      <n-divider style="margin: 8px 0" />
      <div class="star-popover-footer">
        <n-input
          v-model:value="newListName"
          size="small"
          placeholder="新建列表名称"
          @keyup.enter="createAndAdd"
        />
        <n-button size="small" type="primary" :loading="creating" :disabled="!newListName.trim()" @click="createAndAdd">
          新建并添加
        </n-button>
      </div>
    </div>
  </n-popover>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NCheckbox, NDivider, NEmpty, NIcon, NInput, NPopover, NSpin, useMessage } from 'naive-ui'
import { StarOutline, Star } from '@vicons/ionicons5'
import { watchlistApi, type Watchlist } from '@/api'
import { useWatchlistStore } from '@/stores/watchlist'

const props = defineProps<{ symbol: string }>()
const message = useMessage()
const watchlistStore = useWatchlistStore()

const loading = ref(false)
const toggling = ref<Record<string, boolean>>({})
const newListName = ref('')
const creating = ref(false)

const watchlists = computed(() => watchlistStore.watchlists)
const isStarred = computed(() => watchlists.value.some((wl) => wl.items?.some((item) => item.symbol === props.symbol)))

function isInWatchlist(wl: Watchlist) {
  return wl.items?.some((item) => item.symbol === props.symbol) ?? false
}

async function loadWatchlists() {
  loading.value = true
  try {
    await watchlistStore.ensureWatchlistsLoaded()
  } catch (err: any) {
    message.error(err.message || '获取自选列表失败')
  } finally {
    loading.value = false
  }
}

function handleShowChange(show: boolean) {
  if (show && !watchlistStore.watchlists.length) void loadWatchlists()
}

async function toggle(watchlistId: string, checked: boolean) {
  toggling.value[watchlistId] = true
  try {
    if (checked) {
      await watchlistApi.addSymbol(watchlistId, props.symbol)
    } else {
      await watchlistApi.removeSymbol(watchlistId, props.symbol)
    }
    await watchlistStore.loadWatchlists()
  } catch (err: any) {
    message.error(err.message || '操作失败')
  } finally {
    toggling.value[watchlistId] = false
  }
}

async function createAndAdd() {
  const name = newListName.value.trim()
  if (!name) return
  creating.value = true
  try {
    await watchlistApi.create({ name, symbols: [props.symbol] })
    await watchlistStore.loadWatchlists()
    newListName.value = ''
    message.success(`已创建列表 "${name}" 并添加标的`)
  } catch (err: any) {
    message.error(err.message || '创建失败')
  } finally {
    creating.value = false
  }
}

onMounted(() => {
  void watchlistStore.ensureWatchlistsLoaded()
})
</script>

<style scoped>
.star-popover-content {
  min-width: 200px;
  max-width: 280px;
  padding: 8px 12px;
}
.star-popover-header {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
  color: var(--color-text);
}
.star-popover-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
}
.star-popover-label {
  margin-left: 4px;
}
.star-popover-count {
  margin-left: 2px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.star-popover-footer {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
