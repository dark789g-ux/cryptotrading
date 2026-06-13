<template>
  <AppModal
    v-model:show="visible"
    title="添加 A 股标的"
    :description="watchlist ? `目标列表：${watchlist.name}` : ''"
    width="min(560px, 92vw)"
    :mask-closable="!submitting"
    :closable="!submitting"
  >
    <div class="add-symbols-body">
      <n-input
        v-model:value="inputText"
        type="textarea"
        :rows="6"
        :disabled="submitting"
        placeholder="每行或逗号分隔输入 ts_code，如 000001.SZ"
      />

      <div v-if="inputText.trim()" class="add-summary">
        <div class="add-summary-item add-summary-valid">
          合法 <strong>{{ stats.valid }}</strong>
        </div>
        <div class="add-summary-item add-summary-dup">
          输入内重复 <strong>{{ stats.duplicate }}</strong>
        </div>
        <div class="add-summary-item add-summary-invalid">
          非法 <strong>{{ stats.invalid }}</strong>
        </div>
        <div class="add-summary-item add-summary-overlap">
          与列表重叠 <strong>{{ stats.overlap }}</strong>
        </div>
      </div>
    </div>

    <template #actions>
      <n-button :disabled="submitting" @click="visible = false">取消</n-button>
      <n-button
        type="primary"
        :loading="submitting"
        :disabled="!canConfirm"
        @click="handleConfirm"
      >
        确认添加
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import AppModal from '@/components/common/AppModal.vue'
import { watchlistApi, type Watchlist } from '@/api'

type TokenStatus = 'valid' | 'duplicate' | 'invalid'

interface ParsedToken {
  symbol: string
  status: TokenStatus
  overlap: boolean
}

const props = defineProps<{
  show: boolean
  watchlist: Watchlist | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  added: []
}>()

const message = useMessage()

const visible = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
})

const SYMBOL_RE = /^\d{6}\.(SH|SZ|BJ)$/i

const inputText = ref('')
const submitting = ref(false)

watch(visible, (v) => {
  if (!v) {
    resetState()
  }
})

function resetState() {
  inputText.value = ''
  submitting.value = false
}

function parseInput(text: string, existingSymbols: Set<string>): ParsedToken[] {
  const tokens = text
    .split(/[\n,，]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const seen = new Set<string>()
  const result: ParsedToken[] = []

  for (const raw of tokens) {
    const upper = raw.toUpperCase()

    if (!SYMBOL_RE.test(raw)) {
      result.push({ symbol: upper, status: 'invalid', overlap: false })
      continue
    }

    if (seen.has(upper)) {
      result.push({
        symbol: upper,
        status: 'duplicate',
        overlap: existingSymbols.has(upper),
      })
      continue
    }

    seen.add(upper)
    result.push({
      symbol: upper,
      status: 'valid',
      overlap: existingSymbols.has(upper),
    })
  }

  return result
}

const parsedTokens = computed(() => {
  const existingSet = new Set(
    (props.watchlist?.items ?? []).map((i) => i.symbol.toUpperCase()),
  )
  return parseInput(inputText.value, existingSet)
})

const stats = computed(() => {
  let valid = 0
  let duplicate = 0
  let invalid = 0
  let overlap = 0
  for (const t of parsedTokens.value) {
    if (t.status === 'valid') valid++
    else if (t.status === 'duplicate') duplicate++
    else invalid++
    if (t.status === 'valid' && t.overlap) overlap++
  }
  return { valid, duplicate, invalid, overlap }
})

const validSymbols = computed(() =>
  parsedTokens.value.filter((t) => t.status === 'valid').map((t) => t.symbol),
)

const canConfirm = computed(
  () => !submitting.value && validSymbols.value.length > 0 && !!props.watchlist,
)

async function handleConfirm() {
  if (!canConfirm.value || !props.watchlist) return
  const wl = props.watchlist
  const symbols = validSymbols.value
  submitting.value = true
  try {
    const result = await watchlistApi.upsertByName({ name: wl.name, symbols })
    if (result.created) {
      message.success(`新建列表「${result.name}」并添加 ${result.added} 个`)
    } else {
      message.success(`已添加 ${result.added} 个，跳过 ${result.skipped} 个`)
    }
    emit('added')
    visible.value = false
  } catch (err: any) {
    const msg: string = err?.response?.data?.message ?? err?.message ?? '添加失败'
    message.error(msg)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.add-symbols-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.add-summary {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.add-summary-item {
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  background: var(--color-surface-elevated, rgba(0, 0, 0, 0.04));
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.08));
}
.add-summary-item strong {
  margin-left: 4px;
  font-weight: 700;
}
.add-summary-valid strong { color: #18a058; }
.add-summary-dup strong { color: #f0a020; }
.add-summary-invalid strong { color: #d03050; }
.add-summary-overlap strong { color: #2080f0; }
</style>
