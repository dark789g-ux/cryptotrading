<template>
  <n-select
    :value="modelValue"
    :options="opts"
    :placeholder="placeholder"
    :multiple="multiple"
    :clearable="clearable"
    :loading="store.loadingVersions"
    filterable
    size="small"
    style="min-width: 260px"
    @update:value="onUpdate"
  />
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { useQuantStore } from '@/stores/quant'
import type { ModelVersionInfo } from '@/api/modules/quant'

/**
 * 模型版本切换器
 *
 * - 接口 ModelVersionOption 必须 extends SelectOption（CLAUDE.md Naive UI 规范）
 * - 内部通过 useQuantStore 共享版本列表，避免每个 view 重复拉取
 * - 外部可通过 `versions` prop 覆盖（如测试场景）
 */
export interface ModelVersionOption extends SelectOption {
  label: string
  value: string
  createdAt?: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string | string[] | null
    multiple?: boolean
    clearable?: boolean
    placeholder?: string
    /** 外部传入版本列表则跳过 store 拉取（测试 / 离线模式用） */
    versions?: ModelVersionInfo[]
  }>(),
  {
    multiple: false,
    clearable: false,
    placeholder: '选择模型版本',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string | string[] | null]
  change: [value: string | string[] | null]
}>()

const store = useQuantStore()

const opts = computed<ModelVersionOption[]>(() => {
  const list = props.versions ?? store.availableModelVersions
  return list.map(v => ({
    label: v.created_at
      ? `${v.model_version}  ·  ${formatCreatedAt(v.created_at)}`
      : v.model_version,
    value: v.model_version,
    createdAt: v.created_at,
  }))
})

function formatCreatedAt(iso: string): string {
  // 后端按 timestamptz 出 UTC 字符串；这里只做轻量截断，不做时区换算
  return iso.slice(0, 10)
}

function onUpdate(v: string | string[] | null) {
  emit('update:modelValue', v)
  emit('change', v)
}

onMounted(() => {
  if (!props.versions) {
    // 不 await：保持 mount 同步；loading 由 store.loadingVersions 暴露
    void store.fetchAvailableVersions()
  }
})
</script>
