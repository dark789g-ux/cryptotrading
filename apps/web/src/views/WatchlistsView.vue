<template>
  <div class="watchlists-view">
    <div class="page-header">
      <h1 class="page-title">自选列表</h1>
      <n-button type="primary" @click="openCreate">
        <template #icon><n-icon><add-outline /></n-icon></template>
        新建列表
      </n-button>
    </div>

    <div class="lists-grid">
      <n-card v-if="loading" :bordered="false">
        <n-spin />
      </n-card>

      <n-card v-else-if="!watchlists.length" :bordered="false">
        <n-empty description="暂无自选列表，点击右上角新建" />
      </n-card>

      <n-card
        v-for="wl in watchlists"
        :key="wl.id"
        class="watchlist-card"
        :bordered="false"
        :title="wl.name"
      >
        <template #header-extra>
          <n-space>
            <n-button size="small" quaternary @click="openEdit(wl)">
              <template #icon><n-icon><create-outline /></n-icon></template>
            </n-button>
            <n-button size="small" quaternary type="error" @click="deleteWatchlist(wl)">
              <template #icon><n-icon><trash-outline /></n-icon></template>
            </n-button>
          </n-space>
        </template>

        <div class="symbol-tags">
          <n-empty v-if="!wl.items?.length" description="暂无标的" size="small" />
          <n-tag
            v-for="item in wl.items"
            :key="item.id"
            size="small"
            round
          >
            {{ item.symbol }}
          </n-tag>
        </div>
        <div class="card-footer">
          <span class="count">{{ wl.items?.length ?? 0 }} 个标的</span>
          <span class="date">{{ new Date(wl.createdAt).toLocaleDateString('zh-CN') }}</span>
        </div>
      </n-card>
    </div>

    <!-- 新建/编辑弹窗 -->
    <n-modal
      v-model:show="showModal"
      :title="editTarget ? '编辑列表' : '新建列表'"
      preset="dialog"
      style="width: 500px"
      :show-icon="false"
    >
      <n-form label-placement="top" style="margin-top:8px">
        <n-form-item label="列表名称">
          <n-input v-model:value="form.name" placeholder="请输入名称" />
        </n-form-item>
        <n-form-item label="标的">
          <n-select
            v-model:value="form.symbols"
            multiple
            filterable
            placeholder="搜索并选择标的"
            :options="symbolOptions"
            :loading="loadingSymbols"
            max-tag-count="responsive"
          />
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showModal = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="handleSubmit">保存</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useMessage, useDialog } from 'naive-ui'
import { AddOutline, CreateOutline, TrashOutline } from '@vicons/ionicons5'
import { watchlistApi, symbolApi } from '../composables/useApi'

const message = useMessage()
const dialog = useDialog()

const watchlists = ref<any[]>([])
const loading = ref(false)
const showModal = ref(false)
const submitting = ref(false)
const editTarget = ref<any>(null)
const form = ref({ name: '', symbols: [] as string[] })
const symbolOptions = ref<{ label: string; value: string }[]>([])
const loadingSymbols = ref(false)

const loadWatchlists = async () => {
  loading.value = true
  try { watchlists.value = await watchlistApi.list() }
  catch (err: any) { message.error(err.message) }
  finally { loading.value = false }
}

const loadSymbols = async () => {
  loadingSymbols.value = true
  try {
    const names = await symbolApi.getNames('1h')
    symbolOptions.value = names.map((s) => ({ label: s, value: s }))
  } finally { loadingSymbols.value = false }
}

const openCreate = () => {
  editTarget.value = null
  form.value = { name: '', symbols: [] }
  showModal.value = true
  if (!symbolOptions.value.length) loadSymbols()
}

const openEdit = (wl: any) => {
  editTarget.value = wl
  form.value = { name: wl.name, symbols: wl.items?.map((i: any) => i.symbol) ?? [] }
  showModal.value = true
  if (!symbolOptions.value.length) loadSymbols()
}

const handleSubmit = async () => {
  if (!form.value.name.trim()) { message.warning('请输入列表名称'); return }
  submitting.value = true
  try {
    if (editTarget.value) {
      await watchlistApi.update(editTarget.value.id, { name: form.value.name, symbols: form.value.symbols })
      message.success('更新成功')
    } else {
      await watchlistApi.create({ name: form.value.name, symbols: form.value.symbols })
      message.success('创建成功')
    }
    showModal.value = false
    loadWatchlists()
  } catch (err: any) {
    message.error(err.message)
  } finally {
    submitting.value = false
  }
}

const deleteWatchlist = (wl: any) => {
  dialog.warning({
    title: '确认删除',
    content: `确定要删除列表 "${wl.name}" 吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try { await watchlistApi.delete(wl.id); message.success('删除成功'); loadWatchlists() }
      catch (err: any) { message.error(err.message) }
    },
  })
}

onMounted(loadWatchlists)
</script>

<style scoped>
.watchlists-view { max-width: 1200px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.page-title { font-family: 'Playfair Display', Georgia, serif; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; color: var(--ember-text); margin: 0; }
.lists-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 24px; }
.watchlist-card { background: var(--ember-surface); transition: box-shadow 0.2s ease, transform 0.2s ease; }
.watchlist-card:hover { transform: translateY(-2px); box-shadow: 0 4px 16px rgba(28, 25, 23, 0.06); }
.symbol-tags { display: flex; flex-wrap: wrap; gap: 8px; min-height: 40px; }
.card-footer { display: flex; justify-content: space-between; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--ember-border); }
.count, .date { font-size: 12px; color: var(--ember-neutral); }
</style>
