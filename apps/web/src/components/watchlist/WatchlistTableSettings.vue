<template>
  <column-settings-drawer
    v-model:show="showProxy"
    title="列设置"
    :definitions="columnDefs"
    v-model="draftPreferences"
    :saving="saving"
    @save="handleSave"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import ColumnSettingsDrawer from '@/components/symbols/ColumnSettingsDrawer.vue'
import { createWatchlistColumnDefs } from './watchlistColumnDefs'
import { useWatchlistColumnPreferences } from '@/composables/watchlist/useWatchlistColumnPreferences'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const message = useMessage()

const showProxy = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value),
})

const columnDefs = computed(() => createWatchlistColumnDefs({
  scoresMap: ref(new Map()),
  scoresLoading: ref(false),
  hitLookup: ref(new Map()),
  onViewChart: () => {},
  onRemove: () => {},
}))

const { scopePreferences, saving, save } = useWatchlistColumnPreferences(columnDefs)
const draftPreferences = ref([...scopePreferences.value])

watch(() => props.show, (visible) => {
  if (visible) {
    draftPreferences.value = [...scopePreferences.value]
  }
})

async function handleSave() {
  scopePreferences.value = draftPreferences.value
  save()
  showProxy.value = false
  message.success('列设置已保存')
}
</script>
