<template>
  <div class="market-index-scope-panel">
    <div class="toolbar">
      <n-button
        type="primary"
        :loading="discovering"
        data-testid="discover-btn"
        @click="handleDiscover"
      >
        发现候选
      </n-button>
      <n-checkbox v-model:checked="onlyNotInScope">仅看未加入</n-checkbox>
      <n-space align="center" :size="6">
        <n-switch v-model:value="hideNoise" />
        <span class="switch-label">隐藏疑似噪声</span>
      </n-space>
      <n-button :loading="loadingScope" @click="loadScope">刷新范围</n-button>
    </div>

    <n-alert
      v-if="discoverFailedItems.length > 0"
      type="warning"
      :show-icon="true"
      class="failed-alert"
    >
      部分数据源返回空或失败：{{ discoverFailedItems.join('、') }}（候选清单可能不完整）
    </n-alert>

    <MarketIndexScopeTable
      :rows="scopeRows"
      :loading="loadingScope"
      @removed="onRemoved"
    />

    <MarketIndexCandidateTable
      :rows="filteredCandidates"
      :loading="discovering"
      @added="onAdded"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NCheckbox, NSpace, NSwitch, useMessage } from 'naive-ui'
import {
  HIDDEN_NOISE_TAGS,
  marketIndexScopeApi,
  type MarketIndexCandidate,
  type MarketIndexScopeRow,
} from '@/api'
import MarketIndexScopeTable from '@/components/sync/MarketIndexScopeTable.vue'
import MarketIndexCandidateTable from '@/components/sync/MarketIndexCandidateTable.vue'

defineOptions({ name: 'MarketIndexScopePanel' })

const message = useMessage()

// 当前范围（catalog type='M'）。
const scopeRows = ref<MarketIndexScopeRow[]>([])
const loadingScope = ref(false)

// 发现的候选（含 in_scope 标注）。discover 有 Tushare 积分成本，本地缓存避免重复调。
const candidates = ref<MarketIndexCandidate[]>([])
const discovering = ref(false)
const discoverFailedItems = ref<string[]>([])

// 过滤开关。
const onlyNotInScope = ref(false)
const hideNoise = ref(true)

const filteredCandidates = computed<MarketIndexCandidate[]>(() => {
  let list = candidates.value
  if (hideNoise.value) {
    list = list.filter(
      (c) => !c.noise_tags.some((t) => HIDDEN_NOISE_TAGS.has(t)),
    )
  }
  if (onlyNotInScope.value) {
    list = list.filter((c) => !c.in_scope)
  }
  return list
})

async function loadScope() {
  loadingScope.value = true
  try {
    scopeRows.value = await marketIndexScopeApi.list()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loadingScope.value = false
  }
}

async function handleDiscover() {
  discovering.value = true
  try {
    // discover 前先刷新 scope，保证 in_scope 标注与当前范围一致。
    await loadScope()
    const scopeSet = new Set(scopeRows.value.map((r) => r.ts_code))
    const result = await marketIndexScopeApi.discover()
    candidates.value = result.candidates.map((c) => ({
      ...c,
      in_scope: scopeSet.has(c.ts_code),
    }))
    discoverFailedItems.value = result.failedItems
    if (result.candidates.length === 0 && result.failedItems.length > 0) {
      message.warning('未发现候选，且部分数据源失败，请查看提示')
    } else {
      message.success(`发现 ${result.candidates.length} 个候选`)
    }
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    discovering.value = false
  }
}

/** 加入范围后：刷新 scope + 把对应 candidate 的 in_scope 翻转为 true（避免重复 discover）。 */
async function onAdded(tsCode: string) {
  await loadScope()
  const c = candidates.value.find((x) => x.ts_code === tsCode)
  if (c) c.in_scope = true
}

/** 移除后：刷新 scope + 把对应 candidate 的 in_scope 翻转为 false。 */
async function onRemoved(tsCode: string) {
  await loadScope()
  const c = candidates.value.find((x) => x.ts_code === tsCode)
  if (c) c.in_scope = false
}

onMounted(() => {
  void loadScope()
})
</script>

<style scoped>
.market-index-scope-panel {
  padding: 4px 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.switch-label {
  font-size: 13px;
}
.failed-alert {
  margin-bottom: 12px;
}
</style>
