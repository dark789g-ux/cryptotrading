# AGENTS.md — apps/web/

> **L2（按需加载）**：Vue 3 前端规范。需要具体实现时再读对应源文件（L3）。

---

## 文件速查

| 路径 | 说明 |
|------|------|
| `src/composables/useApi.ts` | 所有 API 调用的唯一入口（`strategyApi`, `backtestApi`, `symbolApi` 等） |
| `src/composables/useSSE.ts` | SSE 封装（fetch streaming，支持 POST body；`start/reset`，暴露 `status/percent/phase/message`） |
| `src/composables/useTheme.ts` | 亮/暗主题切换（`theme`, `isDark`, `toggleTheme`） |
| `src/styles/glassmorphism.css` | 全局 CSS 变量（`--glass-bg`, `--glass-blur`, `--text-primary` 等） |
| `src/router/index.ts` | 路由定义（5 个页面） |
| `src/App.vue` | 根组件，Naive UI Provider + Layout |
| `src/components/layout/` | `Layout.vue`（整体骨架）、`Sidebar.vue`（导航） |
| `src/components/backtest/` | `StrategyModal.vue`（新建/编辑策略）、`BacktestDetail.vue`（回测详情 Drawer） |
| `src/views/BacktestView.vue` | 策略列表 + 运行回测（SSE）+ 历史 Drawer |
| `src/views/SymbolsView.vue` | 标的筛选 + K 线图表（ECharts） |
| `src/views/SyncView.vue` | 数据同步（SSE 进度）+ 偏好配置 |
| `src/views/WatchlistsView.vue` | 自选列表 CRUD |
| `src/views/SettingsView.vue` | 排除标的 + 全局配置 |

---

## 关键约定

- **API 调用**：一律通过 `useApi.ts` 中的对象方法，不在组件内直接 `fetch`
- **SSE**：使用 `useSSE` composable；同步用 GET，回测用 POST（传 `{ method: 'POST', body: {...} }`）
- **样式**：Naive UI 组件 + `glassmorphism.css` CSS 变量；不引入新 UI 库；`scoped` 样式写在 `<style scoped>` 内
- **TypeScript**：`<script setup lang="ts">`；`any[]` 仅用于 Naive UI DataTable columns 等库类型不完整处
- **图表**：ECharts（`echarts/core` 按需引入），不引入其他图表库
- **开发代理**：`/api` → `localhost:3000`（vite.config.ts proxy），生产由 nginx 代理

---

## 修改指引

| 想做的事 | 改哪里 |
|---------|-------|
| 新增 API 端点调用 | `composables/useApi.ts` 对应的 API 对象内添加方法 |
| 新增页面 | 新建 `src/views/<Name>View.vue`，在 `router/index.ts` 注册，在 `Sidebar.vue` 加导航项 |
| 修改主题色 | `App.vue` → `themeOverrides.common.primaryColor` |
| 修改全局 CSS 变量 | `styles/glassmorphism.css` |
| 修改策略表单字段 | `components/backtest/StrategyModal.vue` |
| 修改回测结果展示 | `components/backtest/BacktestDetail.vue` |
