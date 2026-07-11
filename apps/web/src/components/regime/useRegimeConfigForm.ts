import { reactive, ref, computed, watch, type Ref } from 'vue'
import { useMessage } from 'naive-ui'
import {
  makeDefaultQuadrant,
  cloneQuadrant,
  bucketConditionEqual,
  validateRegimeEditorForm,
  buildRegimeConfigDto,
  buildRegimeConfigMap,
} from '@/components/regime/regimeConfigEditor.helpers'
import { generateUniqueKey } from '@/utils/pinyin'
import type {
  QuadrantEntry,
  RegimeStrategyConfig,
  CreateRegimeConfigDto,
  RegimeConfigMap,
} from '@/api/modules/strategy/regimeEngine'

export interface RegimeConfigFormState {
  version: number
  note: string | null
  quadrants: QuadrantEntry[]
}

export interface UseRegimeConfigFormOptions {
  initialData: Ref<RegimeStrategyConfig | null | undefined>
  mode: Ref<'create' | 'edit' | 'duplicate'>
}

function makeSeedQuadrant(): QuadrantEntry {
  return makeDefaultQuadrant('q1', '象限1')
}

function makeDefaultForm(): RegimeConfigFormState {
  return {
    version: 1,
    note: '',
    quadrants: [makeSeedQuadrant()],
  }
}

/**
 * Regime 象限配置表单状态：quadrants、校验、添加/导入象限、validateAndGetConfig。
 * 供 RegimeConfigEditor 壳与后续 6-Tab FormPanel 复用。
 */
export function useRegimeConfigForm(options: UseRegimeConfigFormOptions) {
  const message = useMessage()
  const form = reactive(makeDefaultForm())
  const activeTab = ref(form.quadrants[0]?.key ?? '')
  const saving = ref(false)

  watch(
    () => options.initialData.value,
    (data) => {
      if (!data) return
      form.version = options.mode.value === 'duplicate' ? data.version + 1 : data.version
      form.note = data.note ?? ''
      const cfg = data.config as unknown as Record<string, unknown>
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

  const isSingleQuadrant = computed(() => form.quadrants.length === 1)

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

  /** Chrome 确认添加后调用；label 已 trim 且非空 */
  function addQuadrant(label: string) {
    const key = generateUniqueKey(
      label,
      form.quadrants.map((q) => q.key),
    )
    form.quadrants.push(makeDefaultQuadrant(key, label))
    activeTab.value = key
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
    activeTab.value =
      newKeys[0] ?? form.quadrants[form.quadrants.length - 1]?.key ?? ''
  }

  function removeQuadrant(idx: number) {
    form.quadrants.splice(idx, 1)
    if (!form.quadrants.some((q) => q.key === activeTab.value)) {
      activeTab.value = form.quadrants[0]?.key ?? ''
    }
  }

  function applyValidation(skipVersion?: boolean): boolean {
    const result = validateRegimeEditorForm({
      version: form.version,
      quadrants: form.quadrants,
      isSingleQuadrant: isSingleQuadrant.value,
      skipVersion,
    })
    if (result.focusKey) activeTab.value = result.focusKey
    if (result.error) {
      message.warning(result.error)
      return false
    }
    return true
  }

  function handleSave(emitSave: (dto: CreateRegimeConfigDto) => void) {
    if (!applyValidation()) return
    saving.value = true
    try {
      emitSave(buildRegimeConfigDto(form))
    } finally {
      saving.value = false
    }
  }

  /** embedded 模式供父级调用：校验失败返回 null，成功返回 RegimeConfigMap */
  function validateAndGetConfig(): RegimeConfigMap | null {
    if (!applyValidation(true)) return null
    return buildRegimeConfigMap(form)
  }

  return {
    form,
    activeTab,
    saving,
    isSingleQuadrant,
    overlapWarnings,
    addQuadrant,
    handleImportQuadrants,
    removeQuadrant,
    applyValidation,
    handleSave,
    validateAndGetConfig,
  }
}
