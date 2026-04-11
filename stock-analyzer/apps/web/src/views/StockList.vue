<template>
  <div class="stock-list">
    <el-card>
      <template #header>
        <div class="header">
          <span>股票列表</span>
          <div class="actions">
            <el-input
              v-model="searchKeyword"
              placeholder="输入代码或名称搜索"
              style="width: 200px"
              @keyup.enter="handleSearch"
            >
              <template #append>
                <el-button @click="handleSearch">
                  <el-icon><Search /></el-icon>
                </el-button>
              </template>
            </el-input>
            <el-button type="primary" @click="showFilter = true">
              <el-icon><Filter /></el-icon>
              高级筛选
            </el-button>
          </div>
        </div>
      </template>

      <el-table
        :data="stocks"
        v-loading="loading"
        @row-click="handleRowClick"
        highlight-current-row
      >
        <el-table-column prop="tsCode" label="代码" width="120" />
        <el-table-column prop="name" label="名称" width="120" />
        <el-table-column prop="industry" label="行业" width="120" />
        <el-table-column prop="market" label="市场" width="100" />
        <el-table-column prop="area" label="地区" width="100" />
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="addToWatchlist(row)">
              加入自选
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="limit"
        :total="total"
        :page-sizes="[20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        @change="fetchStocks"
        class="pagination"
      />
    </el-card>

    <!-- 高级筛选弹窗 -->
    <AdvancedFilter v-model="showFilter" @confirm="handleFilter" />

    <!-- 添加到自选弹窗 -->
    <el-dialog v-model="showAddDialog" title="添加到自选股" width="400px">
      <el-form>
        <el-form-item label="选择分组">
          <el-select v-model="selectedWatchlist" placeholder="请选择">
            <el-option
              v-for="wl in watchlists"
              :key="wl.id"
              :label="wl.name"
              :value="wl.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="confirmAdd">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search, Filter } from '@element-plus/icons-vue'
import { stockApi, watchlistApi } from '@/api'
import AdvancedFilter from '@/components/AdvancedFilter.vue'

const router = useRouter()
const loading = ref(false)
const stocks = ref([])
const total = ref(0)
const page = ref(1)
const limit = ref(50)
const searchKeyword = ref('')
const showFilter = ref(false)
const showAddDialog = ref(false)
const watchlists = ref([])
const selectedWatchlist = ref('')
const selectedStock = ref<any>(null)

const fetchStocks = async () => {
  loading.value = true
  try {
    const { data } = await stockApi.getStocks({
      page: page.value,
      limit: limit.value,
    })
    stocks.value = data.data
    total.value = data.total
  } finally {
    loading.value = false
  }
}

const handleSearch = async () => {
  if (!searchKeyword.value) {
    fetchStocks()
    return
  }
  loading.value = true
  try {
    const { data } = await stockApi.searchStocks(searchKeyword.value)
    stocks.value = data
    total.value = data.length
  } finally {
    loading.value = false
  }
}

const handleFilter = async (filter: any) => {
  loading.value = true
  try {
    const { data } = await stockApi.filterStocks(filter)
    stocks.value = data.map((item: any) => item.stock)
    total.value = data.length
  } finally {
    loading.value = false
  }
}

const handleRowClick = (row: any) => {
  router.push(`/stock/${row.tsCode}`)
}

const addToWatchlist = async (row: any) => {
  selectedStock.value = row
  const { data } = await watchlistApi.getWatchlists()
  watchlists.value = data
  if (data.length > 0) {
    selectedWatchlist.value = data[0].id
  }
  showAddDialog.value = true
}

const confirmAdd = async () => {
  if (!selectedWatchlist.value) {
    ElMessage.warning('请选择分组')
    return
  }
  try {
    await watchlistApi.addItem(selectedWatchlist.value, {
      tsCode: selectedStock.value.tsCode,
    })
    ElMessage.success('添加成功')
    showAddDialog.value = false
  } catch (error: any) {
    ElMessage.error(error.response?.data?.message || '添加失败')
  }
}

onMounted(fetchStocks)
</script>

<style scoped>
.stock-list {
  max-width: 1200px;
  margin: 0 auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.actions {
  display: flex;
  gap: 10px;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}
</style>
