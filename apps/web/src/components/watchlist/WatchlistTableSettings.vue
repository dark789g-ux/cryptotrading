<template>
  <n-drawer :show="show" placement="right" :width="320" @update:show="(v: boolean) => emit('update:show', v)">
    <n-drawer-content title="列设置" closable>
      <n-spin v-if="loading" size="small" />
      <n-checkbox-group v-else v-model:value="selected">
        <n-space vertical>
          <n-checkbox v-for="col in allColumns" :key="col" :value="col" :label="col" />
        </n-space>
      </n-checkbox-group>
      <template #footer>
        <n-space justify="end">
          <n-button @click="reset">恢复默认</n-button>
          <n-button type="primary" @click="save">保存</n-button>
        </n-space>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  NDrawer, NDrawerContent, NCheckbox, NCheckboxGroup, NSpace, NButton, NSpin,
} from 'naive-ui'
import { symbolApi } from '@/api'
import { useWatchlistStore } from '@/stores/watchlist'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const store = useWatchlistStore()
const allColumns = ref<string[]>([])
const selected = ref<string[]>([...store.columns])
const loading = ref(false)

watch(() => props.show, async (visible) => {
  if (visible) {
    selected.value = [...store.columns]
    if (!allColumns.value.length) {
      loading.value = true
      try {
        allColumns.value = await symbolApi.getKlineColumns()
      } finally {
        loading.value = false
      }
    }
  }
})

function save() {
  store.saveColumns(selected.value)
  emit('update:show', false)
}

function reset() {
  selected.value = ['symbol', 'close', 'ma5', 'ma30', 'kdjJ', 'riskRewardRatio']
}
</script>
