import { computed, ref } from 'vue'
import type {
  CustomIndexDetail,
  CustomIndexMemberRow,
  CustomIndexType,
  CustomWeightMethod,
} from '@/api/modules/market/customIndex'
import { customIndexApi } from '@/api/modules/market/customIndex'

export interface WizardMember {
  conCode: string
  name: string
  weight?: number
}

export interface CreateCustomIndexWizardState {
  name: string
  description: string
  members: WizardMember[]
  weightMethod: CustomWeightMethod
  customWeights: Record<string, number>
  baseDate: string | null
  basePoint: number
  indexType: CustomIndexType
  effectiveDate: string | null
}

const MIN_MEMBERS = 2
const MAX_MEMBERS = 500

function todayYmd(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function defaultState(): CreateCustomIndexWizardState {
  const ymd = todayYmd()
  return {
    name: '',
    description: '',
    members: [],
    weightMethod: 'equal',
    customWeights: {},
    baseDate: ymd,
    basePoint: 1000,
    indexType: 'price',
    effectiveDate: ymd,
  }
}

export function useCreateCustomIndexWizard() {
  const step = ref(1)
  const state = ref<CreateCustomIndexWizardState>(defaultState())
  const editId = ref<string | null>(null)
  const previewMembers = ref<CustomIndexMemberRow[]>([])
  const previewLoading = ref(false)
  const actualStartDate = ref<string | null>(null)

  const stepTitles = ['基本信息', '成分选取', '权重方案', '基期与口径', '预览确认']

  const memberCount = computed(() => state.value.members.length)

  async function loadForEdit(id: string) {
    editId.value = id
    const detail: CustomIndexDetail = await customIndexApi.getById(id)
    state.value = {
      name: detail.name,
      description: detail.description ?? '',
      members: detail.members.map((m) => ({
        conCode: m.conCode,
        name: m.name,
        weight: m.weight,
      })),
      weightMethod: detail.weightMethod,
      customWeights: Object.fromEntries(
        detail.members.map((m) => [m.conCode, Math.round(m.weight * 10000) / 100]),
      ),
      baseDate: detail.baseDate,
      basePoint: detail.basePoint,
      indexType: detail.indexType,
      effectiveDate: detail.effectiveDate,
    }
    actualStartDate.value = null
    step.value = 1
  }

  function reset() {
    step.value = 1
    state.value = defaultState()
    editId.value = null
    previewMembers.value = []
    actualStartDate.value = null
  }

  function addMember(member: WizardMember) {
    if (state.value.members.some((m) => m.conCode === member.conCode)) return false
    if (state.value.members.length >= MAX_MEMBERS) return false
    state.value.members.push(member)
    return true
  }

  function removeMember(conCode: string) {
    state.value.members = state.value.members.filter((m) => m.conCode !== conCode)
    delete state.value.customWeights[conCode]
  }

  function setMembersFromImport(items: Array<{ conCode: string; name: string }>) {
    const existing = new Set(state.value.members.map((m) => m.conCode))
    for (const item of items) {
      if (existing.has(item.conCode)) continue
      if (state.value.members.length >= MAX_MEMBERS) break
      state.value.members.push({ conCode: item.conCode, name: item.name })
      existing.add(item.conCode)
    }
  }

  function validateStep(targetStep: number): string | null {
    if (targetStep >= 2) {
      if (!state.value.name.trim()) return '请输入指数名称'
      if (state.value.name.trim().length > 100) return '名称最多 100 字'
    }
    if (targetStep >= 3) {
      if (state.value.members.length < MIN_MEMBERS) return `至少选择 ${MIN_MEMBERS} 只成分股`
      if (state.value.members.length > MAX_MEMBERS) return `成分股最多 ${MAX_MEMBERS} 只`
    }
    if (targetStep >= 4) {
      if (state.value.weightMethod === 'custom') {
        const sum = state.value.members.reduce(
          (acc, m) => acc + (state.value.customWeights[m.conCode] ?? 0),
          0,
        )
        if (Math.abs(sum - 100) > 0.01) return '自定义权重合计须为 100%'
      }
    }
    if (targetStep >= 5) {
      if (!state.value.baseDate) return '请选择基期日期'
      if (!state.value.effectiveDate) return '请选择调仓生效日'
      if (state.value.basePoint <= 0) return '基点须大于 0'
    }
    return null
  }

  async function refreshWeightPreview() {
    if (state.value.members.length < MIN_MEMBERS) {
      previewMembers.value = []
      return
    }
    const effectiveDate = state.value.effectiveDate ?? state.value.baseDate ?? todayYmd()
    previewLoading.value = true
    try {
      const body = {
        weight_method: state.value.weightMethod,
        effective_date: effectiveDate,
        members: state.value.members.map((m) => ({
          con_code: m.conCode,
          ...(state.value.weightMethod === 'custom'
            ? { weight: (state.value.customWeights[m.conCode] ?? 0) / 100 }
            : {}),
        })),
      }
      const res = await customIndexApi.previewWeights(body)
      previewMembers.value = res.members
      for (const m of res.members) {
        const local = state.value.members.find((x) => x.conCode === m.conCode)
        if (local) local.weight = m.weight
      }
    } catch {
      previewMembers.value = state.value.members.map((m) => ({
        conCode: m.conCode,
        name: m.name,
        weight:
          state.value.weightMethod === 'custom'
            ? (state.value.customWeights[m.conCode] ?? 0) / 100
            : 1 / state.value.members.length,
      }))
    } finally {
      previewLoading.value = false
    }
  }

  function buildSubmitBody() {
    const s = state.value
    const effectiveDate = s.effectiveDate ?? s.baseDate ?? todayYmd()
    const members = s.members.map((m) => ({
      con_code: m.conCode,
      ...(s.weightMethod === 'custom'
        ? { weight: (s.customWeights[m.conCode] ?? 0) / 100 }
        : {}),
    }))
    return {
      name: s.name.trim(),
      description: s.description.trim() || undefined,
      index_type: s.indexType,
      base_date: s.baseDate!,
      base_point: s.basePoint,
      weight_method: s.weightMethod,
      effective_date: effectiveDate,
      members,
      custom_weights:
        s.weightMethod === 'custom'
          ? members.map((m) => ({ con_code: m.con_code, weight: m.weight! }))
          : null,
    }
  }

  async function submitCreate() {
    return customIndexApi.create(buildSubmitBody())
  }

  async function submitUpdate() {
    if (!editId.value) throw new Error('缺少编辑 ID')
    const body = buildSubmitBody()
    return customIndexApi.update(editId.value, {
      name: body.name,
      description: body.description,
      index_type: body.index_type,
      weight_method: body.weight_method,
      effective_date: body.effective_date,
      members: body.members,
      custom_weights: body.custom_weights,
    })
  }

  const isEditMode = computed(() => editId.value != null)

  return {
    step,
    state,
    editId,
    previewMembers,
    previewLoading,
    actualStartDate,
    stepTitles,
    memberCount,
    isEditMode,
    loadForEdit,
    reset,
    addMember,
    removeMember,
    setMembersFromImport,
    validateStep,
    refreshWeightPreview,
    submitCreate,
    submitUpdate,
    MIN_MEMBERS,
    MAX_MEMBERS,
  }
}
