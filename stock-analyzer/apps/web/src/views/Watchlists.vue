<template>
  <div class="watchlists">
    <el-row :gutter="20">
      <el-col :span="6">
        <el-card>
          <template #header>
            <div class="header">
              <span>自选股分组</span>
              <el-button type="primary" size="small" @click="showCreateDialog = true">
                <el-icon><Plus /></el-icon>
              </el-button>
            </div>
          </template>
          
          <el-menu
            :default-active="activeWatchlist"
            @select="handleSelect"
          >
            <el-menu-item
              v-for="wl in watchlists"
              :key="wl.id"
              :index="wl.id"
            >
              <el-icon><Folder /></el-icon>
              <span>{{ wl.name }}</span>
              <span class="count">({{ wl.items?.length || 0 }})</span>
            </el-menu-item>
          </el-menu>
        </el-card>
      </el-col>
      
      <el-col :span="18">
        <el-card v-if="currentWatchlist">
          <template #header>
            <div class="header">
              <span>{{ currentWatchlist.name }}</span>
              <div>
                <el-button type="danger" size="small" @click="deleteWatchlist">
                  删除分组
                </el-button>
              </div>
            </div>
          </template>
          
          <el-table :data="currentWatchlist.items" v-loading="loading">
            <el-table-column prop="tsCode" label="代码" width="120" />
            <el-table-column label="名称" width="120">
              <template #default="{ row }">
                <el-link @click="goToStock(row.tsCode)">
                  {{ getStockName(row.tsCode) }}
                </el-link>
              </template>
            </el-table-column>
            <el-table-column prop="note" label="备注" />
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button link type="danger" @click="removeItem(row.id)">
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
        
        <el-empty v-else description="请选择或创建一个分组" />
      </el-col>
    </el-row>

    <!-- 创建分组弹窗 -->
    <el-dialog v-model="showCreateDialog" title="新建分组" width="400px">
      <el-form :model="createForm">
        <el-form-item label="名称" required>
          <el-input v-model="createForm.name" placeholder="请输入分组名称" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input
            v-model="createForm.description"
            type="textarea"
            placeholder="可选"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="createWatchlist">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Folder } from '@element-plus/icons-vue'
import { watchlistApi, stockApi } from '@/api'

const router = useRouter()
const watchlists = ref([])
const currentWatchlist = ref<any>(null)
const activeWatchlist = ref('')
const loading = ref(false)
const showCreateDialog = ref(false)
const createForm = ref({ name: '', description: '' })
const stockNames = ref<Record<string, string>>({})

const fetchWatchlists = async () => {
  const { data } = await watchlistApi.getWatchlists()
  watchlists.value = data
  
  if (data.length > 0 && !activeWatchlist.value) {
    activeWatchlist.value = data[0].id
    await fetchWatchlistDetail(data[0].id)
  }
}

const fetchWatchlistDetail = async (id: string) => {
  loading.value = true
  try {
    const { data } = await watchlistApi.getWatchlist(id)
    currentWatchlist.value = data
    
    // 获取股票名称
    for (const item of data.items) {
      if (!stockNames.value[item.tsCode]) {
        try {
          const { data: stock } = await stockApi.getStock(item.tsCode)
          stockNames.value[item.tsCode] = stock.name
        } catch {
          stockNames.value[item.tsCode] = item.tsCode
        }
      }
    }
  } finally {
    loading.value = false
  }
}

const handleSelect = (id: string) => {
  activeWatchlist.value = id
  fetchWatchlistDetail(id)
}

const getStockName = (tsCode: string) => {
  return stockNames.value[tsCode] || tsCode
}

const createWatchlist = async () => {
  if (!createForm.value.name) {
    ElMessage.warning('请输入分组名称')
    return
  }
  
  try {
    await watchlistApi.createWatchlist(createForm.value)
    ElMessage.success('创建成功')
    showCreateDialog.value = false
    createForm.value = { name: '', description: '' }
    await fetchWatchlists()
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '创建失败')
  }
}

const deleteWatchlist = async () => {
  try {
    await ElMessageBox.confirm('确定删除该分组吗？', '提示', {
      type: 'warning',
    })
    await watchlistApi.deleteWatchlist(activeWatchlist.value)
    ElMessage.success('删除成功')
    activeWatchlist.value = ''
    currentWatchlist.value = null
    await fetchWatchlists()
  } catch {
    // 取消
  }
}

const removeItem = async (itemId: string) => {
  try {
    await watchlistApi.removeItem(activeWatchlist.value, itemId)
    ElMessage.success('删除成功')
    await fetchWatchlistDetail(activeWatchlist.value)
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '删除失败')
  }
}

const goToStock = (tsCode: string) => {
  router.push(`/stock/${tsCode}`)
}

onMounted(fetchWatchlists)
</script>

<style scoped>
.watchlists {
  max-width: 1400px;
  margin: 0 auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.count {
  margin-left: 8px;
  color: #909399;
  font-size: 12px;
}
</style>
