<template>
  <AppModal
    v-model:show="visible"
    title="从现有配置导入象限"
    description="选择源配置与导入范围；不会导入版本号、备注、状态。"
    width="min(560px, 92vw)"
    :mask-closable="!loading"
    :closable="!loading"
  >
    <div class="regime-import-quadrants">
      <n-form-item label="导入范围" label-placement="left">
        <n-radio-group v-model:value="importMode" direction="vertical">
          <n-radio value="quadrants_only">仅导入象限列表</n-radio>
          <n-radio value="quadrants_with_position">导入象限列表 + 仓位参数</n-radio>
        </n-radio-group>
      </n-form-item>

      <n-divider style="margin: 8px 0 12px" />

      <div class="regime-import-source">
        <div class="regime-import-source__label">源配置</div>
        <div v-if="loading" class="regime-import-source__state">
          <n-spin size="small" />
        </div>
        <n-empty v-else-if="configs.length === 0" description="暂无可用配置" class="regime-import-source__state" />
        <n-list v-else hoverable clickable class="regime-import-source__list">
          <n-list-item
            v-for="cfg in configs"
            :key="cfg.id"
            :class="['regime-import-source__item', { 'is-selected': selectedId === cfg.id }]"
            @click="selectedId = cfg.id"
          >
            <n-thing :title="`版本 ${cfg.version}`" :description="cfg.note || '无备注'">
              <template #header-extra>
                <n-radio :checked="selectedId === cfg.id" @click.stop="selectedId = cfg.id" />
              </template>
            </n-thing>
          </n-list-item>
        </n-list>
      </div>
    </div>

    <template #actions>
      <n-button :disabled="loading" @click="visible = false">取消</n-button>
      <n-button type="primary" :disabled="!canApply" :loading="loading" @click="handleApply">应用</n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NButton,
  NDivider,
  NEmpty,
  NFormItem,
  NList,
  NListItem,
  NRadio,
  NRadioGroup,
  NSpin,
  NThing,
  useMessage,
} from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import { regimeEngineApi } from '@/api/modules/strategy/regimeEngine'
import type { QuadrantEntry, RegimeStrategyConfig } from '@/api/modules/strategy/regimeEngine'

type ImportMode = 'quadrants_only' | 'quadrants_with_position'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  'update:show': [value: boolean]
  import: [quadrants: QuadrantEntry[]]
}>()

const message = useMessage()

const visible = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
})

const loading = ref(false)
const configs = ref<RegimeStrategyConfig[]>([])
const selectedId = ref<string | null>(null)
const importMode = ref<ImportMode>('quadrants_only')

const canApply = computed(() => !loading.value && selectedId.value !== null)

watch(visible, (isOpen) => {
  if (isOpen) {
    selectedId.value = null
    importMode.value = 'quadrants_only'
    void loadConfigs()
  }
})

async function loadConfigs() {
  loading.value = true
  try {
    configs.value = await regimeEngineApi.listConfigs()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '加载配置失败')
    configs.value = []
  } finally {
    loading.value = false
  }
}

function cloneConditions<T>(items?: T[] | null): T[] {
  return items ? items.map((c) => ({ ...c })) : []
}

function extractQuadrants(source: RegimeStrategyConfig, mode: ImportMode): QuadrantEntry[] {
  return source.config.quadrants.map((q) => {
    const entry: QuadrantEntry = {
      key: q.key,
      label: q.label,
      match: cloneConditions(q.match),
      action: q.action,
    }
    if (q.action === 'trade') {
      entry.entryConditions = cloneConditions(q.entryConditions)
      if (q.exitMode) {
        entry.exitMode = q.exitMode
        entry.exitParams = q.exitParams ? { ...q.exitParams } : null
      }
    }
    if (mode === 'quadrants_with_position') {
      entry.positionRatio = q.positionRatio ?? null
      entry.maxPositions = q.maxPositions ?? null
    }
    return entry
  })
}

function handleApply() {
  const source = configs.value.find((c) => c.id === selectedId.value)
  if (!source) return
  const quadrants = extractQuadrants(source, importMode.value)
  emit('import', quadrants)
  visible.value = false
}
</script>

<style scoped>
.regime-import-quadrants {
  display: flex;
  flex-direction: column;
}

.regime-import-source__label {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--color-text);
}

.regime-import-source__state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
}

.regime-import-source__list {
  max-height: min(50vh, 320px);
  overflow-y: auto;
}

.regime-import-source__item {
  cursor: pointer;
}

.regime-import-source__item.is-selected {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}
</style>
