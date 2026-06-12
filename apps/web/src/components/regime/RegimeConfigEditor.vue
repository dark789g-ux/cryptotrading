<template>
  <div class="regime-config-editor">
    <n-form label-placement="left" label-width="70" :model="form">
      <n-form-item label="版本">
        <n-input-number
          v-model:value="form.version"
          :min="1"
          :max="9999"
          style="width: 120px"
        />
      </n-form-item>
      <n-form-item label="备注">
        <n-input
          v-model:value="form.note"
          placeholder="配置备注（可选）"
          style="max-width: 400px"
        />
      </n-form-item>
    </n-form>

    <n-tabs v-model:value="activeTab" type="line" animated>
      <n-tab-pane
        v-for="key in REGIME_KEYS"
        :key="key"
        :name="key"
        :tab="quadrantTabLabel(key)"
      >
        <n-form label-placement="left" label-width="80" :model="form.config[key]">
          <n-form-item label="动作">
            <n-select
              :value="form.config[key].action"
              :options="ACTION_OPTIONS"
              style="width: 160px"
              @update:value="(v: 'trade' | 'flat') => setAction(key, v)"
            />
          </n-form-item>

          <n-form-item label="标签">
            <n-input
              v-model:value="form.config[key].label"
              placeholder="象限标签（如「强多头」）"
              style="max-width: 300px"
            />
          </n-form-item>

          <template v-if="form.config[key].action === 'trade'">
            <n-divider>入场条件</n-divider>

            <condition-rows
              :conditions="(form.config[key].entryConditions as StrategyConditionItem[] ?? [])"
              target-type="a-share"
              default-operator="gt"
              default-compare-mode="value"
              @update:conditions="(v: StrategyConditionItem[]) => form.config[key].entryConditions = v"
            />

            <n-divider>出场设置</n-divider>

            <n-form-item label="出场模式">
              <n-select
                :value="form.config[key].exitMode"
                :options="EXIT_MODE_OPTIONS"
                clearable
                placeholder="选择出场模式"
                style="width: 200px"
                @update:value="(v: string | null) => setExitMode(key, v)"
              />
            </n-form-item>

            <template v-if="form.config[key].exitMode === 'trailing_lock'">
              <n-form-item label="maxHold">
                <n-input-number
                  :value="(form.config[key].exitParams?.maxHold as number | null ?? null)"
                  :min="1"
                  placeholder="可为空"
                  clearable
                  style="width: 160px"
                  @update:value="(v: number | null) => setExitParam(key, 'maxHold', v)"
                />
              </n-form-item>
            </template>

            <template v-else-if="form.config[key].exitMode === 'fixed_n'">
              <n-form-item label="N（天数）">
                <n-input-number
                  :value="(form.config[key].exitParams?.N as number ?? undefined)"
                  :min="1"
                  placeholder="正整数"
                  style="width: 160px"
                  @update:value="(v: number | null) => setExitParam(key, 'N', v)"
                />
              </n-form-item>
            </template>

            <template v-else-if="form.config[key].exitMode === 'strategy'">
              <n-form-item label="退出条件">
                <condition-rows
                  :conditions="(form.config[key].exitParams?.exitConditions as StrategyConditionItem[] ?? [])"
                  target-type="a-share"
                  default-operator="lt"
                  default-compare-mode="value"
                  @update:conditions="(v: StrategyConditionItem[]) => setExitParam(key, 'exitConditions', v)"
                />
              </n-form-item>
              <n-form-item label="maxHold">
                <n-input-number
                  :value="(form.config[key].exitParams?.maxHold as number | null ?? null)"
                  :min="1"
                  placeholder="可为空"
                  clearable
                  style="width: 160px"
                  @update:value="(v: number | null) => setExitParam(key, 'maxHold', v)"
                />
              </n-form-item>
            </template>
          </template>
        </n-form>
      </n-tab-pane>
    </n-tabs>

    <div class="regime-config-editor__actions">
      <n-button @click="emit('cancel')">取消</n-button>
      <n-button type="primary" :loading="saving" @click="handleSave">保存</n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NTabs,
  NTabPane,
  NDivider,
  NButton,
  useMessage,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import ConditionRows from '@/components/strategy-conditions/ConditionRows.vue'
import type { StrategyConditionItem } from '@/api/modules/strategy/strategyConditions'
import type {
  RegimeKey,
  RegimeConfigEntry,
  RegimeStrategyConfig,
  CreateRegimeConfigDto,
} from '@/api/modules/strategy/regimeEngine'

const REGIME_KEYS: RegimeKey[] = ['Q1', 'Q2', 'Q3', 'Q4']

const QUADRANT_LABELS: Record<RegimeKey, string> = {
  Q1: 'Q1 强多头',
  Q2: 'Q2 多头回调',
  Q3: 'Q3 反弹筑底',
  Q4: 'Q4 空头',
}

const ACTION_OPTIONS: SelectOption[] = [
  { label: 'trade（交易）', value: 'trade' },
  { label: 'flat（空仓）', value: 'flat' },
]

const EXIT_MODE_OPTIONS: SelectOption[] = [
  { label: 'trailing_lock（尾部锁定）', value: 'trailing_lock' },
  { label: 'fixed_n（固定天数）', value: 'fixed_n' },
  { label: 'strategy（策略出场）', value: 'strategy' },
]

interface Props {
  initialData?: RegimeStrategyConfig | null
  mode: 'create' | 'edit' | 'duplicate'
}

const props = withDefaults(defineProps<Props>(), {
  initialData: null,
})

const emit = defineEmits<{
  save: [dto: CreateRegimeConfigDto]
  cancel: []
}>()

const message = useMessage()
const saving = ref(false)
const activeTab = ref<RegimeKey>('Q1')

function makeDefaultEntry(): RegimeConfigEntry {
  return {
    action: 'trade',
    label: null,
    entryConditions: [],
    exitMode: null,
    exitParams: null,
  }
}

function makeDefaultConfig(): Record<RegimeKey, RegimeConfigEntry> {
  return {
    Q1: makeDefaultEntry(),
    Q2: makeDefaultEntry(),
    Q3: makeDefaultEntry(),
    Q4: makeDefaultEntry(),
  }
}

function cloneEntry(entry: RegimeConfigEntry): RegimeConfigEntry {
  return {
    ...entry,
    entryConditions: entry.entryConditions
      ? (entry.entryConditions as StrategyConditionItem[]).map((c) => ({ ...c }))
      : [],
    exitParams: entry.exitParams ? { ...entry.exitParams } : null,
  }
}

const form = reactive({
  version: 1,
  note: '' as string | null,
  config: makeDefaultConfig(),
})

function quadrantTabLabel(key: RegimeKey): string {
  const label = form.config[key].label?.trim()
  return label ? `${key} ${label}` : QUADRANT_LABELS[key]
}

function setAction(key: RegimeKey, action: 'trade' | 'flat') {
  form.config[key].action = action
  if (action === 'flat') {
    form.config[key].entryConditions = []
    form.config[key].exitMode = null
    form.config[key].exitParams = null
  }
}

function setExitMode(key: RegimeKey, mode: string | null) {
  form.config[key].exitMode = mode as RegimeConfigEntry['exitMode']
  if (!mode) {
    form.config[key].exitParams = null
    return
  }
  if (mode === 'trailing_lock') {
    form.config[key].exitParams = { maxHold: null }
  } else if (mode === 'fixed_n') {
    form.config[key].exitParams = { N: undefined }
  } else if (mode === 'strategy') {
    form.config[key].exitParams = { exitConditions: [], maxHold: null }
  }
}

function setExitParam(key: RegimeKey, param: string, value: unknown) {
  if (!form.config[key].exitParams) {
    form.config[key].exitParams = {}
  }
  form.config[key].exitParams![param] = value
}

watch(
  () => props.initialData,
  (data) => {
    if (!data) return
    form.version = props.mode === 'duplicate' ? data.version + 1 : data.version
    form.note = data.note ?? ''
    form.config = makeDefaultConfig()
    for (const key of REGIME_KEYS) {
      const entry = data.config[key]
      if (entry) {
        form.config[key] = cloneEntry(entry)
      }
    }
  },
  { immediate: true },
)

function buildDto(): CreateRegimeConfigDto {
  const config = {} as Record<RegimeKey, RegimeConfigEntry>
  for (const key of REGIME_KEYS) {
    const e = form.config[key]
    const entry: RegimeConfigEntry = { action: e.action }
    if (e.label?.trim()) entry.label = e.label.trim()
    if (e.action === 'trade') {
      const conds = (e.entryConditions ?? []) as StrategyConditionItem[]
      if (conds.length > 0) entry.entryConditions = conds
      if (e.exitMode) {
        entry.exitMode = e.exitMode
        if (e.exitParams) {
          const p = { ...e.exitParams }
          if (e.exitMode === 'trailing_lock' && p.maxHold == null) {
            delete p.maxHold
          }
          if (Object.keys(p).length > 0) entry.exitParams = p
        }
      }
    }
    config[key] = entry
  }
  return JSON.parse(JSON.stringify({ version: form.version, note: form.note || null, config }))
}

function handleSave() {
  if (!form.version || form.version < 1) {
    message.warning('版本号必须为正整数')
    return
  }
  for (const key of REGIME_KEYS) {
    const e = form.config[key]
    if (e.action === 'trade' && e.exitMode === 'fixed_n') {
      const n = e.exitParams?.N as number | undefined
      if (!n || n < 1) {
        message.warning(`${key} 的 fixed_n 天数必须为正整数`)
        activeTab.value = key
        return
      }
    }
  }
  saving.value = true
  try {
    emit('save', buildDto())
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.regime-config-editor {
  padding: 4px 0;
}

.regime-config-editor__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
