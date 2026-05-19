<template>
  <AppModal
    v-model:show="visible"
    title="从 CSV 导入"
    :description="watchlist ? `目标列表：${watchlist.name}` : ''"
    width="min(720px, 92vw)"
    :mask-closable="!submitting"
    :closable="!submitting"
  >
    <div class="csv-import-body">
      <!-- 文件选择 -->
      <div class="csv-file-row">
        <input
          ref="fileInputRef"
          type="file"
          accept=".csv,.txt"
          style="display: none"
          @change="onFileChange"
        />
        <n-button :disabled="submitting" @click="triggerFilePick">
          {{ fileName ? '重新选择文件' : '选择 CSV 文件' }}
        </n-button>
        <span v-if="fileName" class="csv-file-info">
          {{ fileName }} · 共 {{ totalRows }} 行
        </span>
        <span v-else class="csv-file-hint">
          支持 UTF-8 编码（含/不含 BOM），单列 symbol 或带 symbol/name 列
        </span>
      </div>

      <n-alert v-if="parseError" type="error" :show-icon="true">
        {{ parseError }}
      </n-alert>

      <!-- 摘要 -->
      <div v-if="fileName && !parseError" class="csv-summary">
        <div class="csv-summary-item csv-summary-valid">
          合法 <strong>{{ stats.valid }}</strong>
        </div>
        <div class="csv-summary-item csv-summary-dup">
          CSV 内重复 <strong>{{ stats.duplicate }}</strong>
        </div>
        <div class="csv-summary-item csv-summary-invalid">
          非法 <strong>{{ stats.invalid }}</strong>
        </div>
        <div class="csv-summary-item csv-summary-overlap">
          与现有重叠 <strong>{{ stats.overlap }}</strong>
        </div>
      </div>

      <!-- 预览表格 -->
      <div v-if="previewRows.length > 0" class="csv-preview">
        <div class="csv-preview-title">
          预览（前 {{ previewRows.length }} 行 / 共 {{ rows.length }} 行）
        </div>
        <n-data-table
          size="small"
          :columns="previewColumns"
          :data="previewRows"
          :max-height="320"
          :row-class-name="rowClassName"
          :row-props="rowProps"
          :bordered="false"
          :single-line="false"
        />
      </div>

      <!-- 导入模式 -->
      <div v-if="fileName && !parseError" class="csv-mode">
        <span class="csv-mode-label">导入模式：</span>
        <n-radio-group v-model:value="mode" :disabled="submitting">
          <n-radio value="append">追加合并（默认）</n-radio>
          <n-radio value="overwrite">覆盖</n-radio>
        </n-radio-group>
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
        {{ mode === 'overwrite' ? '确认覆盖导入' : '确认导入' }}
      </n-button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import type { DataTableColumns } from 'naive-ui'
import {
  NAlert,
  NButton,
  NDataTable,
  NRadio,
  NRadioGroup,
  NTooltip,
  useMessage,
} from 'naive-ui'
import Papa from 'papaparse'
import AppModal from '@/components/common/AppModal.vue'
import { watchlistApi, type Watchlist } from '@/api'

type RowStatus = 'valid' | 'duplicate' | 'invalid'

interface ParsedRow {
  rowNo: number
  symbol: string
  name: string
  status: RowStatus
  reason: string
  overlap: boolean
}

const props = defineProps<{
  show: boolean
  watchlist: Watchlist | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  imported: []
}>()

const message = useMessage()

const visible = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
})

const SYMBOL_RE = /^\d{6}\.(SH|SZ|BJ)$/i

const fileInputRef = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const totalRows = ref(0)
const rows = ref<ParsedRow[]>([])
const parseError = ref('')
const mode = ref<'append' | 'overwrite'>('append')
const submitting = ref(false)

// 弹窗关闭时重置状态
watch(visible, (v) => {
  if (!v) {
    resetState()
  }
})

function resetState() {
  fileName.value = ''
  totalRows.value = 0
  rows.value = []
  parseError.value = ''
  mode.value = 'append'
  submitting.value = false
  if (fileInputRef.value) {
    fileInputRef.value.value = ''
  }
}

function triggerFilePick() {
  fileInputRef.value?.click()
}

async function onFileChange(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  await parseCsvFile(file)
}

async function parseCsvFile(file: File) {
  parseError.value = ''
  fileName.value = file.name

  try {
    // 读取文本，剥离 UTF-8 BOM
    let text = await file.text()
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1)
    }

    const parsed = Papa.parse<string[]>(text, {
      skipEmptyLines: 'greedy',
      // 不使用 header 模式：自行判断首行是否为表头
    })

    if (parsed.errors && parsed.errors.length > 0) {
      const firstErr = parsed.errors[0]
      // 仅对致命错误抛出；常见的 quote/delimiter 警告允许通过
      if (firstErr.type === 'Delimiter' || firstErr.code === 'UndetectableDelimiter') {
        parseError.value = `CSV 解析失败：${firstErr.message}`
        rows.value = []
        totalRows.value = 0
        return
      }
    }

    const data = (parsed.data as string[][]).filter((r) => r && r.some((c) => (c ?? '').trim() !== ''))
    if (data.length === 0) {
      parseError.value = '文件为空或无有效行'
      rows.value = []
      totalRows.value = 0
      return
    }

    // 判断首行是否为表头：首格是否匹配 symbol 正则
    const firstCellRaw = (data[0][0] ?? '').trim()
    const firstIsData = SYMBOL_RE.test(firstCellRaw)
    let headerRow: string[] | null = null
    let bodyStart = 0
    if (!firstIsData) {
      headerRow = data[0].map((c) => (c ?? '').trim().toLowerCase())
      bodyStart = 1
    }

    let symbolIdx = 0
    let nameIdx = -1
    if (headerRow) {
      const sIdx = headerRow.indexOf('symbol')
      if (sIdx >= 0) symbolIdx = sIdx
      const nIdx = headerRow.indexOf('name')
      if (nIdx >= 0) nameIdx = nIdx
    } else {
      // 无表头：默认第 1 列为 symbol；若有第 2 列，作为 name 显示
      nameIdx = data[0].length > 1 ? 1 : -1
    }

    const body = data.slice(bodyStart)
    totalRows.value = body.length

    const existingSet = new Set(
      (props.watchlist?.items ?? []).map((i) => i.symbol.toUpperCase()),
    )

    const seen = new Set<string>()
    const result: ParsedRow[] = []
    body.forEach((cols, idx) => {
      const rowNo = idx + 1
      const rawSym = (cols[symbolIdx] ?? '').trim()
      const nameVal = nameIdx >= 0 ? (cols[nameIdx] ?? '').trim() : ''
      const upper = rawSym.toUpperCase()

      if (!rawSym) {
        result.push({
          rowNo,
          symbol: rawSym,
          name: nameVal,
          status: 'invalid',
          reason: 'symbol 为空',
          overlap: false,
        })
        return
      }

      if (!SYMBOL_RE.test(rawSym)) {
        result.push({
          rowNo,
          symbol: upper,
          name: nameVal,
          status: 'invalid',
          reason: '不符合 A 股 symbol 格式 ^\\d{6}\\.(SH|SZ|BJ)$',
          overlap: false,
        })
        return
      }

      if (seen.has(upper)) {
        result.push({
          rowNo,
          symbol: upper,
          name: nameVal,
          status: 'duplicate',
          reason: 'CSV 文件内重复出现',
          overlap: existingSet.has(upper),
        })
        return
      }

      seen.add(upper)
      result.push({
        rowNo,
        symbol: upper,
        name: nameVal,
        status: 'valid',
        reason: '',
        overlap: existingSet.has(upper),
      })
    })

    rows.value = result
  } catch (err: any) {
    parseError.value = `读取文件失败：${err?.message ?? err}`
    rows.value = []
    totalRows.value = 0
  }
}

const stats = computed(() => {
  let valid = 0
  let duplicate = 0
  let invalid = 0
  let overlap = 0
  for (const r of rows.value) {
    if (r.status === 'valid') valid++
    else if (r.status === 'duplicate') duplicate++
    else invalid++
    if (r.status === 'valid' && r.overlap) overlap++
  }
  return { valid, duplicate, invalid, overlap }
})

const validSymbols = computed(() =>
  rows.value.filter((r) => r.status === 'valid').map((r) => r.symbol),
)

const previewRows = computed(() => rows.value.slice(0, 100))

const canConfirm = computed(
  () =>
    !!fileName.value &&
    !parseError.value &&
    !submitting.value &&
    validSymbols.value.length > 0 &&
    !!props.watchlist,
)

const previewColumns: DataTableColumns<ParsedRow> = [
  { title: '#', key: 'rowNo', width: 56 },
  { title: 'symbol', key: 'symbol', width: 140 },
  { title: 'name', key: 'name', ellipsis: { tooltip: true } },
  {
    title: '状态',
    key: 'status',
    width: 120,
    render(row) {
      const label =
        row.status === 'valid'
          ? row.overlap
            ? '合法（已存在）'
            : '合法'
          : row.status === 'duplicate'
          ? '重复'
          : '非法'
      if (row.status === 'invalid' && row.reason) {
        return h(
          NTooltip,
          { trigger: 'hover' },
          {
            trigger: () => h('span', { class: 'csv-status-invalid' }, label),
            default: () => row.reason,
          },
        )
      }
      const cls =
        row.status === 'valid'
          ? row.overlap
            ? 'csv-status-overlap'
            : 'csv-status-valid'
          : 'csv-status-dup'
      return h('span', { class: cls }, label)
    },
  },
]

function rowClassName(row: ParsedRow): string {
  if (row.status === 'invalid') return 'csv-row-invalid'
  if (row.status === 'duplicate') return 'csv-row-duplicate'
  if (row.status === 'valid' && row.overlap) return 'csv-row-overlap'
  return ''
}

function rowProps(row: ParsedRow) {
  if (row.status === 'invalid' && row.reason) {
    return { title: row.reason }
  }
  return {}
}

async function handleConfirm() {
  if (!canConfirm.value || !props.watchlist) return
  const wl = props.watchlist
  const symbols = validSymbols.value
  submitting.value = true
  try {
    if (mode.value === 'overwrite') {
      await watchlistApi.update(wl.id, { symbols })
      message.success(`已覆盖列表，写入 ${symbols.length} 个 symbol`)
    } else {
      const result = await watchlistApi.upsertByName({ name: wl.name, symbols })
      if (result.created) {
        message.success(`新建列表「${result.name}」并添加 ${result.added} 个`)
      } else {
        message.success(`已添加 ${result.added} 个，跳过 ${result.skipped} 个`)
      }
    }
    emit('imported')
    visible.value = false
  } catch (err: any) {
    const msg: string = err?.response?.data?.message ?? err?.message ?? '导入失败'
    message.error(msg)
    // 失败时弹窗不关闭，便于用户重试
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.csv-import-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.csv-file-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.csv-file-info {
  font-size: 13px;
  color: var(--color-text);
}

.csv-file-hint {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.csv-summary {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.csv-summary-item {
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  background: var(--color-surface-elevated, rgba(0, 0, 0, 0.04));
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.08));
}
.csv-summary-item strong {
  margin-left: 4px;
  font-weight: 700;
}
.csv-summary-valid strong { color: #18a058; }
.csv-summary-dup strong { color: #f0a020; }
.csv-summary-invalid strong { color: #d03050; }
.csv-summary-overlap strong { color: #2080f0; }

.csv-preview-title {
  font-size: 13px;
  color: var(--color-text-secondary);
  margin-bottom: 6px;
}

.csv-mode {
  display: flex;
  align-items: center;
  gap: 8px;
}
.csv-mode-label {
  font-size: 13px;
  color: var(--color-text);
}

:deep(.csv-row-invalid) {
  background: rgba(208, 48, 80, 0.08) !important;
}
:deep(.csv-row-duplicate) {
  background: rgba(240, 160, 32, 0.08) !important;
}
:deep(.csv-row-overlap) {
  background: rgba(32, 128, 240, 0.06) !important;
}

.csv-status-invalid { color: #d03050; font-weight: 600; cursor: help; }
.csv-status-dup { color: #f0a020; font-weight: 600; }
.csv-status-valid { color: #18a058; font-weight: 600; }
.csv-status-overlap { color: #2080f0; font-weight: 600; }
</style>
