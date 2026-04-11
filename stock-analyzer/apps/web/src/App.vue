<template>
  <div class="app">
    <el-container>
      <el-header class="header">
        <div class="logo">
          <el-icon><TrendCharts /></el-icon>
          <span>股票分析系统</span>
        </div>
        <el-menu
          :default-active="$route.path"
          mode="horizontal"
          router
          class="nav-menu"
        >
          <el-menu-item index="/">股票列表</el-menu-item>
          <el-menu-item index="/watchlists">自选股</el-menu-item>
          <el-menu-item index="/backtest">策略回测</el-menu-item>
        </el-menu>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </div>
</template>

<script setup lang="ts">
import { TrendCharts } from '@element-plus/icons-vue'
</script>

<style scoped>
.app {
  min-height: 100vh;
}

.header {
  display: flex;
  align-items: center;
  border-bottom: 1px solid #dcdfe6;
  padding: 0 20px;
}

.logo {
  display: flex;
  align-items: center;
  font-size: 20px;
  font-weight: bold;
  margin-right: 40px;
}

.logo .el-icon {
  font-size: 28px;
  margin-right: 10px;
  color: #409eff;
}

.nav-menu {
  flex: 1;
  border-bottom: none;
}

.main {
  padding: 20px;
  background: #f5f7fa;
  min-height: calc(100vh - 60px);
}
</style>
