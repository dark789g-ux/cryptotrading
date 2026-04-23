# 前端规格文档（Vue 3 + Naive UI）

> **何时阅读**：编写或修改任何 `frontend/src/` 下的代码时。

---

## 技术栈总览

| 维度 | 偏好 | 说明 |
|------|------|------|
| **框架** | **Naive UI** + Vue 3 | 完整组件库，原生主题系统，Tree-shaking 友好 |
| **视觉风格** | **毛玻璃/新拟态** (Glassmorphism) | 半透明背景 + 模糊效果 + 渐变强调色 |
| **主题** | 默认**深色模式**，支持切换 | localStorage 持久化用户选择 |
| **布局** | 可折叠侧边栏 + 右侧内容区 | 桌面端专用，收起后显示图标 |
| **详情展示** | **右侧抽屉** (Drawer) | 回测结果等详情从右侧滑出，不离开当前页 |
| **数据表格** | 完整功能 | 分页、排序、筛选、列显隐控制、导出 CSV |
| **图表** | ECharts | 跟随主题自动切换深色/浅色配色 |
| **动画** | **简洁快速** | 减少动画时长，优先响应速度 |
| **响应式** | **桌面端专用** | 无需适配移动端，可提示"仅支持桌面端" |

---

## 样式规范

- 圆角：卡片 `16px`，按钮/输入框 `10px`
- 强调色：渐变紫蓝 `linear-gradient(135deg, #667eea 0%, #764ba2 100%)`
- 状态色：成功 `#10b981`，警告 `#f59e0b`，错误 `#ef4444`
- 阴影：`0 8px 32px rgba(0, 0, 0, 0.1)`（深色模式加深）

---

## K 线图实现细节

| 配置项 | 实现方式 |
|--------|----------|
| **线条样式** | `smooth: false` 直线连接，无圆滑 |
| **日期格式** | 日线 `YYYY-MM-DD`，小时 `MM-DD HH:00` |
| **MACD 柱** | 当前 > 前一天 = **实心**（同色填充），否则 **空心**（透明+边框）|
| **指标显示** | 每个图左上角显示当前值 + 趋势箭头（↑/↓/-），**随十字线实时更新** |
| **悬浮窗** | 垂直布局：时间、开、高、低、收、涨跌值、涨跌幅 |
| **布局** | 三区域：主图(45%) + KDJ(16%) + MACD(16%)，联动缩放 |
| **数据格式** | CSV 字符串日期，需 `replace(' ', 'T')` 后解析 |

---

## 踩坑记录

### 1. 前后端 API 路由不匹配
**现象**: 前端调用 `/api/klines/0GUSDT?timeframe=1d` 返回 404  
**原因**: 后端路由为 `/klines/{interval}/{symbol}`，但前端按错误格式调用  
**修复**: 统一为 `/api/klines/${timeframe}/${symbol}`，返回 CSV 文本而非 JSON

### 2. Vue Router History 模式 404
**现象**: 直接访问 `/symbols` 返回 `{"detail":"Not Found"}`  
**原因**: FastAPI 的 `StaticFiles(html=True)` 无法处理前端路由  
**修复**: 单独挂载 `/assets`，并添加 catch-all 路由返回 `index.html`

### 3. ECharts K 线数据格式
**现象**: K 线高低点显示错误，涨跌计算异常  
**原因**: ECharts candlestick 数据格式为 `[open, close, low, high]`，容易混淆顺序  
**修复**: 明确注释数据格式，使用变量 `o, c, l, h` 避免命名冲突

### 4. CSV 日期解析失败
**现象**: X 轴显示 "1970-01-01" 或只显示年份  
**原因**: CSV 中是字符串格式 `2025-09-22 18:00:00`，直接使用 `new Date()` 解析失败  
**修复**: 使用 `timestamp.replace(' ', 'T')` 转换为 ISO 格式后再解析

### 5. 图表指标不随十字线更新
**现象**: 左上角指标值固定不变  
**原因**: 只初始化一次，未监听 `updateAxisPointer` 事件  
**修复**: 添加事件监听，十字线移动时调用 `updateIndicatorLabels()` 更新

### 6. 变量名冲突导致构建失败
**现象**: `Identifier 'open' has already been declared`  
**原因**: 解构赋值 `const [open, close, low, high] = kline` 与后续 `const open = kline[0]` 重复  
**修复**: 使用短变量名 `o, c, l, h` 或删除重复声明

### 7. CSV 日期被 parseFloat 截断为年份
**现象**: ECharts tooltip / xAxis 只显示 `2026`（四位年份），不显示完整日期  
**原因**: `isNaN(parseFloat(v)) ? v : parseFloat(v)` 中，`parseFloat("2025-07-30 16:00:00")` 返回 `2025`（非 NaN），导致日期被存为数字  
**修复**: 改用 `isNaN(Number(v)) ? v : parseFloat(v)`；`Number("2025-07-30 16:00:00")` 返回 NaN，日期保留字符串  
**涉及文件**: `frontend/src/views/SymbolsView.vue` CSV 解析段

### 8. ECharts candlestick tooltip `params.data` 格式不可靠
**现象**: tooltip 中 `klineParam.data[0]` 显示的是 K 线序号（如 200），而不是开盘价  
**原因**: ECharts category axis 下 `params.data` 对 candlestick 可能携带 xAxis 内部坐标（category index）作为第 0 维，格式不稳定  
**修复**: 不依赖 `klineParam.data` 的格式，改为直接用闭包里的原始解析数组：`data[dataIndex].open / .close / .low / .high`  
**涉及文件**: `frontend/src/views/SymbolsView.vue` tooltip formatter

### 9. K 线 Drawer 图表的渲染位置
**现象**: 修改 `SymbolChart.vue` 无效，浏览器图表没有任何变化  
**原因**: 标的页的 K 线 Drawer 是在 `SymbolsView.vue` 里通过 `showKlineChart()` 函数内联渲染（`chartRef` div），并非使用 `SymbolChart.vue` 组件  
**教训**: 修改前先确认图表渲染的实际代码位置；`SymbolChart.vue` 是另一套独立组件，两者互不影响
