<template>
  <n-popover
    :show="show"
    @update:show="$emit('update:show', $event)"
    trigger="click"
    placement="bottom-start"
  >
    <template #trigger>
      <n-button type="default" ghost>
        <template #icon>
          <n-icon>
            <DownloadOutline />
          </n-icon>
        </template>
        导入参数
      </n-button>
    </template>
    <div class="import-panel">
      <n-input
        :value="searchText"
        @update:value="$emit('update:searchText', $event)"
        placeholder="搜索策略..."
        clearable
        class="import-search"
      />
      <n-spin :show="loading">
        <n-scrollbar style="max-height: 200px" class="import-list-scroll">
          <n-list hoverable clickable v-if="options.length > 0">
            <n-list-item
              v-for="opt in options"
              :key="opt.value"
              @click="$emit('select', opt.value)"
            >
              {{ opt.label }}
            </n-list-item>
          </n-list>
          <n-empty v-else description="无匹配策略" style="margin-top: 16px" />
        </n-scrollbar>
      </n-spin>
    </div>
  </n-popover>
</template>

<script setup lang="ts">
import {
  NButton,
  NIcon,
  NPopover,
  NInput,
  NSpin,
  NScrollbar,
  NList,
  NListItem,
  NEmpty,
} from 'naive-ui'
import { DownloadOutline } from '@vicons/ionicons5'

defineProps<{
  show: boolean
  searchText: string
  loading: boolean
  options: { label: string; value: string }[]
}>()

defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'update:searchText', v: string): void
  (e: 'select', value: string): void
}>()
</script>

<style scoped>
.import-panel {
  width: 300px;
  padding: 12px;
}
.import-search {
  margin-bottom: 8px;
}
.import-list-scroll {
  margin-top: 8px;
}
</style>
