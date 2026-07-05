<template>
  <div class="regime-config-editor">
    <n-form label-placement="left" label-width="80" :model="form">
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

    <n-space align="center" style="margin-bottom: 12px">
      <n-button @click="openAddModal">+ 添加象限</n-button>
      <n-button @click="showImportModal = true">从现有导入</n-button>
      <n-text v-if="overlapWarnings.length > 0" type="warning">
        {{ overlapWarnings.join('；') }}
      </n-text>
    </n-space>

    <n-tabs v-model:value="activeTab" type="line" animated>
      <n-tab-pane
        v-for="(q, idx) in form.quadrants"
        :key="idx"
        :name="q.key"
        :tab="quadrantTabLabel(q)"
      >
        <n-form label-placement="left" label-width="80">
          <n-form-item label="标签">
            <n-input
              v-model:value="q.label"
              placeholder="象限显示标签"
              style="max-width: 200px"
            />
          </n-form-item>
          <n-form-item label="动作">
            <n-select
              :value="q.action"
              :options="ACTION_OPTIONS"
              style="width: 160px"
              @update:value="(v: 'trade' | 'flat') => setAction(q, v)"
            />
          </n-form-item>

          <template v-if="q.action === 'trade'">
            <n-form-item label="仓位比例">
              <n-input-number :value="q.positionRatio ?? null" :min="0" :max="1" :step="0.01" placeholder="0~1，可选" clearable style="width: 160px" @update:value="(v: number | null) => setPositionParam(q, 'positionRatio', v)" />
            </n-form-item>
            <n-form-item label="最大持仓">
              <n-input-number :value="q.maxPositions ?? null" :min="1" placeholder="正整数，可选" clearable style="width: 160px" @update:value="(v: number | null) => setPositionParam(q, 'maxPositions', v)" />
            </n-form-item>
          </template>

          <n-divider>分桶条件（大盘级）</n-divider>
          <regime-bucket-condition-rows
            :conditions="q.match"
            @update:conditions="(v: RegimeBucketCondition[]) => q.match = v"
          />

          <template v-if="q.action === 'trade'">
            <n-divider>入场条件（个股级）</n-divider>
            <condition-rows
              :conditions="(q.entryConditions ?? [])"
              target-type="a-share"
              default-operator="gt"
              default-compare-mode="value"
              @update:conditions="(v: StrategyConditionItem[]) => q.entryConditions = v"
            />

            <n-divider>出场设置</n-divider>
            <n-form-item label="出场模式">
              <n-select
                :value="q.exitMode"
                :options="EXIT_MODE_OPTIONS"
                clearable
                placeholder="选择出场模式"
                style="width: 200px"
                @update:value="(v: string | null) => setExitMode(q, v)"
              />
            </n-form-item>

            <template v-if="q.exitMode === 'trailing_lock'">
              <n-form-item label="maxHold">
                <n-input-number
                  :value="(q.exitParams?.maxHold as number | null ?? null)"
                  :min="1"
                  placeholder="可为空"
                  clearable
                  style="width: 160px"
                  @update:value="(v: number | null) => setExitParam(q, 'maxHold', v)"
                />
              </n-form-item>
            </template>

            <template v-else-if="q.exitMode === 'fixed_n'">
              <n-form-item label="N（天数）">
                <n-input-number
                  :value="(q.exitParams?.N as number | undefined)"
                  :min="1"
                  placeholder="正整数"
                  style="width: 160px"
                  @update:value="(v: number | null) => setExitParam(q, 'N', v)"
                />
              </n-form-item>
            </template>

            <template v-else-if="q.exitMode === 'strategy'">
              <n-form-item label="退出条件">
                <condition-rows
                  :conditions="(q.exitParams?.exitConditions as StrategyConditionItem[] ?? [])"
                  target-type="a-share"
                  default-operator="lt"
                  default-compare-mode="value"
                  @update:conditions="(v: StrategyConditionItem[]) => setExitParam(q, 'exitConditions', v)"
                />
              </n-form-item>
              <n-form-item label="maxHold">
                <n-input-number
                  :value="(q.exitParams?.maxHold as number | null ?? null)"
                  :min="1"
                  placeholder="必填"
                  style="width: 160px"
                  @update:value="(v: number | null) => setExitParam(q, 'maxHold', v)"
                />
              </n-form-item>
            </template>
          </template>

          <n-form-item>
            <n-button type="error" @click="removeQuadrant(idx)">删除此象限</n-button>
          </n-form-item>
        </n-form>
      </n-tab-pane>
    </n-tabs>

    <div class="regime-config-editor__actions">
      <n-button @click="emit('cancel')">取消</n-button>
      <n-button type="primary" :loading="saving" @click="handleSave">保存</n-button>
    </div>

    <n-modal v-model:show="showAddModal" title="添加象限" preset="card" style="width: 400px">
      <n-form label-placement="left" label-width="60">
        <n-form-item label="标签">
          <n-input v-model:value="newQuadrant.label" placeholder="象限显示标签" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showAddModal = false">取消</n-button>
          <n-button type="primary" @click="confirmAddQuadrant">确定</n-button>
        </n-space>
      </template>
    </n-modal>

    <regime-import-quadrants-modal
      v-model:show="showImportModal"
      @import="handleImportQuadrants"
    />
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, watch } from 'vue'
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
  NSpace,
  NText,
  NModal,
  useMessage,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import ConditionRows from '@/components/strategy-conditions/ConditionRows.vue'
import RegimeBucketConditionRows from '@/components/regime/RegimeBucketConditionRows.vue'
import RegimeImportQuadrantsModal from '@/components/regime/RegimeImportQuadrantsModal.vue'
import { generateUniqueKey } from '@/utils/pinyin'
import type { StrategyConditionItem } from '@/api/modules/strategy/strategyConditions'
import type {
  QuadrantEntry,
  RegimeStrategyConfig,
  CreateRegimeConfigDto,
  RegimeBucketCondition,
} from '@/api/modules/strategy/regimeEngine'

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
const activeTab = ref('')
const showAddModal = ref(false)
const showImportModal = ref(false)
const newQuadrant = reactive({ label: '' })

function makeDefaultQuadrant(key: string, label: string): QuadrantEntry {
  return {
    key,
    label,
    action: 'trade',
    match: [],
    entryConditions: [],
    exitMode: null,
    exitParams: null,
    positionRatio: null,
    maxPositions: null,
  }
}

function makeDefaultForm() {
  return {
    version: 1,
    note: '' as string | null,
    quadrants: [] as QuadrantEntry[],
  }
}


const form = reactive(makeDefaultForm())
function cloneQuadrant(q: QuadrantEntry): QuadrantEntry {
  return {
    key: q.key,
    label: q.label,
    action: q.action,
    match: q.match ? q.match.map((c) => ({ ...c })) : [],
    entryConditions: q.entryConditions ? q.entryConditions.map((c) => ({ ...c })) : [],
    exitMode: q.exitMode ?? null,
    exitParams: q.exitParams ? { ...q.exitParams } : null,
    positionRatio: q.positionRatio ?? null,
    maxPositions: q.maxPositions ?? null,
  }
}
watch(
  () => props.initialData,
  (data) => {
    if (!data) return
    form.version = props.mode === 'duplicate' ? data.version + 1 : data.version
    form.note = data.note ?? ''
    const cfg = (data.config as unknown as Record<string, unknown>)
    if ('quadrants' in cfg) {
      form.quadrants = Array.isArray(cfg.quadrants)
        ? cfg.quadrants.map((q) => cloneQuadrant(q as QuadrantEntry))
        : []
    } else {
      form.quadrants = []
    }
    activeTab.value = form.quadrants[0]?.key ?? ''
  },
  { immediate: true },
)

function quadrantTabLabel(q: QuadrantEntry): string {
  return `${q.key} ${q.label}`
}

function setAction(q: QuadrantEntry, action: 'trade' | 'flat') {
  q.action = action
  if (action === 'flat') {
    q.entryConditions = []
    q.exitMode = null
    q.exitParams = null
  }
}

function setExitMode(q: QuadrantEntry, mode: string | null) {
  q.exitMode = mode as QuadrantEntry['exitMode']
  if (!mode) {
    q.exitParams = null
    return
  }
  if (mode === 'trailing_lock') {
    q.exitParams = { maxHold: null }
  } else if (mode === 'fixed_n') {
    q.exitParams = { N: null }
  } else if (mode === 'strategy') {
    q.exitParams = { exitConditions: [], maxHold: null }
  }
}

function setExitParam(q: QuadrantEntry, param: string, value: unknown) {
  if (!q.exitParams) {
    q.exitParams = {}
  }
  q.exitParams[param] = value
}

function setPositionParam(q: QuadrantEntry, param: 'positionRatio' | 'maxPositions', value: number | null) {
  q[param] = value
}

function openAddModal() {
  newQuadrant.label = ''
  showAddModal.value = true
}

function confirmAddQuadrant() {
  const label = newQuadrant.label.trim()
  if (!label) return message.warning('标签不能为空')
  const key = generateUniqueKey(label, form.quadrants.map((q) => q.key))
  form.quadrants.push(makeDefaultQuadrant(key, label))
  activeTab.value = key
  showAddModal.value = false
  newQuadrant.label = ''
}

function handleImportQuadrants(imported: QuadrantEntry[]) {
  const existingKeys = form.quadrants.map((q) => q.key)
  const newKeys: string[] = []
  for (const q of imported) {
    const cloned = cloneQuadrant(q)
    cloned.key = generateUniqueKey(q.label, existingKeys)
    existingKeys.push(cloned.key)
    newKeys.push(cloned.key)
    form.quadrants.push(cloned)
  }
  activeTab.value = newKeys[0] ?? form.quadrants[form.quadrants.length - 1]?.key ?? ''
  showImportModal.value = false
}

function removeQuadrant(idx: number) {
  form.quadrants.splice(idx, 1)
  if (!form.quadrants.some((q) => q.key === activeTab.value)) {
    activeTab.value = form.quadrants[0]?.key ?? ''
  }
}

function bucketConditionEqual(a: RegimeBucketCondition, b: RegimeBucketCondition): boolean {
  return (
    a.type === b.type &&
    a.target === b.target &&
    a.field === b.field &&
    a.operator === b.operator &&
    a.value === b.value &&
    a.compareField === b.compareField &&
    a.compareMode === b.compareMode
  )
}

const overlapWarnings = computed(() => {
  const warnings: string[] = []
  for (let i = 0; i < form.quadrants.length; i++) {
    for (let j = i + 1; j < form.quadrants.length; j++) {
      const a = form.quadrants[i]
      const b = form.quadrants[j]
      if (a.match.some((ca) => b.match.some((cb) => bucketConditionEqual(ca, cb)))) {
        warnings.push(`"${a.key}" 与 "${b.key}" 的分桶条件可能重叠`)
      }
    }
  }
  return warnings
})
function buildDto(): CreateRegimeConfigDto {
  const quadrants = form.quadrants.map((q) => {
    const entry: QuadrantEntry = {
      key: q.key.trim(),
      label: q.label.trim(),
      match: q.match,
      action: q.action,
    }
    if (q.action === 'trade') {
      entry.entryConditions = q.entryConditions ?? []
      entry.positionRatio = q.positionRatio ?? null
      entry.maxPositions = q.maxPositions ?? null
      if (q.exitMode) {
        entry.exitMode = q.exitMode
        const p = q.exitParams ? { ...q.exitParams } : {}
        if (q.exitMode === 'trailing_lock' && p.maxHold == null) {
          delete p.maxHold
        }
        if (Object.keys(p).length > 0) entry.exitParams = p
      }
    }
    return entry
  })
  return {
    version: form.version,
    note: form.note || null,
    config: {
      quadrants,
    },
  }
}
function handleSave() {
  if (!form.version || form.version < 1) {
    message.warning('版本号必须为正整数')
    return
  }
  if (form.quadrants.length === 0) {
    message.warning('至少配置一个象限')
    return
  }
  const keys = new Set<string>()
  for (const q of form.quadrants) {
    if (keys.has(q.key.trim())) {
      message.warning(`Key 重复: ${q.key}`)
      activeTab.value = q.key
      return
    }
    keys.add(q.key.trim())
    if (!q.label.trim()) {
      message.warning(`象限 ${q.key} 标签不能为空`)
      activeTab.value = q.key
      return
    }
    if (!Array.isArray(q.match) || q.match.length === 0) {
      message.warning(`象限 ${q.key} 分桶条件不能为空`)
      activeTab.value = q.key
      return
    }
    if (q.action === 'trade') {
      if (!Array.isArray(q.entryConditions) || q.entryConditions.length === 0) {
        message.warning(`象限 ${q.key} 入场条件不能为空`)
        activeTab.value = q.key
        return
      }
      const ratio = q.positionRatio
      if (ratio != null && (ratio < 0 || ratio > 1)) {
        message.warning(`象限 ${q.key} 仓位比例必须在 0~1 之间`)
        activeTab.value = q.key
        return
      }
      const maxPos = q.maxPositions
      if (maxPos != null && (!Number.isInteger(maxPos) || maxPos < 1)) {
        message.warning(`象限 ${q.key} 最大持仓必须为正整数或留空`)
        activeTab.value = q.key
        return
      }
      if (q.exitMode === 'fixed_n') {
        const n = q.exitParams?.N as number | undefined
        if (!n || n < 1) {
          message.warning(`象限 ${q.key} 的 fixed_n 天数必须为正整数`)
          activeTab.value = q.key
          return
        }
      }
      if (q.exitMode === 'strategy') {
        const maxHold = q.exitParams?.maxHold as number | null | undefined
        if (!maxHold || maxHold < 1) {
          message.warning(`象限 ${q.key} 的 strategy maxHold 必须为正整数`)
          activeTab.value = q.key
          return
        }
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
