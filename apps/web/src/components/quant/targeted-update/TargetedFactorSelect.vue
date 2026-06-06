<template>
  <div class="factor-select">
    <n-form-item label="因子（可多选）">
      <n-select
        v-model:value="selectedFactorIds"
        :options="factorOptions"
        :loading="loading"
        multiple
        filterable
        clearable
        placeholder="选择要重算的因子…"
        data-testid="targeted-factor-select"
        @update:value="onUpdate"
      />
    </n-form-item>
    <n-form-item label="因子版本" required>
      <n-select
        v-model:value="localVersion"
        :options="versionOptions"
        :loading="loadingVersions"
        filterable
        tag
        clearable
        placeholder="选择 factor_version（默认 v1）"
        data-testid="targeted-factor-version"
        @update:value="onVersionUpdate"
      />
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NFormItem, NSelect, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { quantApi, type FactorDefinition } from '@/api/modules/quant'

interface FactorOption extends SelectOption {
  label: string
  value: string
}

interface VersionOption extends SelectOption {
  label: string
  value: string
}

const props = defineProps<{
  /** 已选因子 ID 列表 */
  factorIds: string[]
  /** 当前选中的 factor_version */
  version: string
}>()

const emit = defineEmits<{
  'update:factorIds': [ids: string[]]
  'update:version': [v: string]
}>()

const message = useMessage()
const loading = ref(false)
const loadingVersions = ref(false)
const factors = ref<FactorDefinition[]>([])
const versionOptions = ref<VersionOption[]>([])

const selectedFactorIds = ref<string[]>(props.factorIds)
const localVersion = ref<string>(props.version || 'v1')

const factorOptions = computed<FactorOption[]>(() =>
  factors.value.map((f) => ({
    label: `${f.factor_id} — ${f.description}`,
    value: f.factor_id,
  })),
)

function onUpdate(ids: string[]) {
  selectedFactorIds.value = ids
  emit('update:factorIds', ids)
}

function onVersionUpdate(v: string | null) {
  localVersion.value = v ?? 'v1'
  emit('update:version', localVersion.value)
}

async function loadFactors() {
  loading.value = true
  try {
    const res = await quantApi.listFactors()
    // 按 display_order 升序
    factors.value = [...(res.items ?? [])].sort((a, b) => a.display_order - b.display_order)
  } catch {
    message.warning('获取因子列表失败，请检查后端连接')
  } finally {
    loading.value = false
  }
}

async function loadVersions() {
  loadingVersions.value = true
  try {
    const res = await quantApi.listFactorVersions()
    versionOptions.value = (res.versions ?? []).map((v) => ({ label: v, value: v }))
    // 若当前版本不在列表中，加入
    if (
      localVersion.value
      && !versionOptions.value.some((o) => o.value === localVersion.value)
    ) {
      versionOptions.value = [
        { label: localVersion.value, value: localVersion.value },
        ...versionOptions.value,
      ]
    }
  } catch {
    message.warning('获取 factor_version 列表失败，可手动输入')
  } finally {
    loadingVersions.value = false
  }
}

onMounted(() => {
  void loadFactors()
  void loadVersions()
})

defineExpose({ selectedFactorIds, localVersion })
</script>

<style scoped>
.factor-select {
  display: contents;
}
</style>
