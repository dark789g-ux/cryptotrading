<template>
  <column-settings-drawer
    v-model:show="showProxy"
    title="列设置"
    :definitions="definitions"
    v-model="draftPreferences"
    :saving="saving"
    @save="handleSave"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import type { ColumnPreferenceItem, WatchlistQuoteRow } from '@/api'
import type { SymbolColumnDef } from '@/components/symbols/columnTypes'
import ColumnSettingsDrawer from '@/components/symbols/ColumnSettingsDrawer.vue'

// 纯受控：列偏好状态由父级 WatchlistTable 的唯一 composable 实例持有，
// 本组件只负责草稿编辑 + 提交，避免再调一次 useWatchlistColumnPreferences
// 产生第二个独立 preferences 实例（会导致保存后表格不即时刷新）。
const props = defineProps<{
  show: boolean
  definitions: SymbolColumnDef<WatchlistQuoteRow>[]
  scopePreferences: ColumnPreferenceItem[]
  saving: boolean
}>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'save', draft: ColumnPreferenceItem[]): void
}>()

const message = useMessage()

const showProxy = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value),
})

const draftPreferences = ref<ColumnPreferenceItem[]>([...props.scopePreferences])

watch(() => props.show, (visible) => {
  if (visible) {
    draftPreferences.value = [...props.scopePreferences]
  }
})

function handleSave() {
  emit('save', draftPreferences.value)
  showProxy.value = false
  message.success('列设置已保存')
}
</script>
