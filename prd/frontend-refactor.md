# PRD：前端重构 + 历史回测 + 数据同步

> 版本：1.0  
> 日期：2026-04-10  
> 状态：待开发

---

## 1. 背景与目标

现有 `symbols.html` 是单一 HTML 文件（超过 500 行），由 `serve_symbols.py`（标准库 HTTP server）驱动。需要：

1. 将前端重构为 **Vue3 + Vite** 工程化项目，文件按模块拆分（每文件 ≤ 500 行）
2. 将后端统一迁移至 **FastAPI**（端口 8000），删除旧的 `serve_symbols.py` 和 `serve_report.py`
3. 新增 **历史回测** 页面：可创建策略配置、执行回测、查看结果
4. 新增 **数据同步** 页面：选择标的和周期后触发数据拉取

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────┐
│  浏览器  http://localhost:8000                           │
│  Vue3 SPA (index.html + JS 路由切换三个视图)             │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP / SSE
┌────────────────────▼────────────────────────────────────┐
│  FastAPI  :8000                                          │
│  ├── 托管 frontend/dist/ 静态文件                        │
│  ├── /api/symbols  /api/klines  /api/filter-strategies   │
│  ├── /api/strategies  (CRUD)                             │
│  ├── /api/backtest/{id}/run  (SSE)                       │
│  └── /api/sync/preferences  /api/sync/run  (SSE)         │
└────────────────────┬────────────────────────────────────┘
                     │ 读写文件
         ┌───────────┴────────────┐
    cache/*.csv           data/
    backtest_results/     ├── strategies.json
                          └── sync_preferences.json
```

---

## 3. 文件结构

```
cryptotrading/
├── main.py                        # FastAPI 启动入口
├── api/
│   ├── __init__.py
│   ├── symbols.py                 # 标的 & K 线 API
│   ├── backtest_api.py            # 策略 CRUD + 回测执行 SSE
│   └── sync_api.py                # 数据同步 API + SSE
├── data/
│   ├── strategies.json            # 策略配置存储
│   └── sync_preferences.json     # 用户同步偏好存储
├── backtest/                      # 原有回测模块（重构 config 支持参数注入）
│   ├── config.py                  # ★ 改为 BacktestConfig dataclass
│   └── ...
├── backtest_strategy.py           # ★ 改为 run(config) -> result 可调用函数
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.js
│       ├── App.vue
│       ├── router/index.js
│       ├── assets/main.css
│       ├── composables/
│       │   ├── useApi.js          # fetch 封装
│       │   └── useSSE.js          # SSE 封装
│       ├── views/
│       │   ├── SymbolsView.vue    # 标的展示
│       │   ├── BacktestView.vue   # 历史回测
│       │   └── SyncView.vue      # 数据同步
│       └── components/
│           ├── layout/
│           │   └── Sidebar.vue    # 折叠侧边栏
│           ├── symbols/
│           │   ├── FilterBar.vue
│           │   ├── SymbolList.vue
│           │   └── SymbolChart.vue
│           ├── backtest/
│           │   ├── StrategyList.vue
│           │   ├── StrategyModal.vue
│           │   ├── ResultDrawer.vue
│           │   ├── PortfolioChart.vue
│           │   ├── TradeTable.vue
│           │   ├── TradeStats.vue
│           └── sync/
│               ├── SymbolSelector.vue
│               └── SyncProgress.vue
```

---

## 4. 后端 API 规范

### 4.1 标的与 K 线

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/intervals` | 返回可用周期列表 `[{id, name}]` |
| GET | `/api/filter-strategies` | 标的筛选用的策略 `[{id, name}]` |
| GET | `/api/symbols?interval=1h&strategy=jdj_ma` | 标的列表（策略筛选） |
| GET | `/api/klines/{interval}/{symbol}` | 返回 K 线 CSV 文本 |

### 4.2 回测策略管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/strategies` | 获取所有策略列表 |
| POST | `/api/strategies` | 创建策略（自动生成 id、name、created_at） |
| PUT | `/api/strategies/{id}` | 更新策略配置 |
| DELETE | `/api/strategies/{id}` | 删除策略 |
| POST | `/api/backtest/{id}/run` | 启动回测，SSE 推送进度 |
| GET | `/api/backtest/{id}/result` | 获取最近一次回测结果 |

#### 策略 JSON 结构

```json
{
  "id": "20260410_143022",
  "name": "MA策略_20260410_1",
  "type": "ma_kdj",
  "created_at": "2026-04-10T14:30:22",
  "params": {
    "initial_capital": 1000000,
    "position_ratio": 0.40,
    "timeframe": "1h",
    "date_start": "2024-01-01",
    "date_end": "2026-04-10",
    "ma_periods": [30, 60, 120, 240],
    "kdj_j_max": 0.0,
    "kdj_k_max": 200.0,
    "kdj_d_max": 200.0,
    "stop_loss_factor": 1.0,
    "enable_partial_profit": false,
    "cooldown_hours": 2,
    "max_positions": 2,
    "min_risk_reward_ratio": 4.0
  },
  "last_backtest_at": "2026-04-10T15:00:00",
  "last_backtest_return": 23.5
}
```

#### 支持的策略类型（可扩展）

| type | 名称 | 参数说明 |
|------|------|---------|
| `ma_kdj` | MA+KDJ 超卖策略 | ma_periods, kdj_j/k/d_max |

### 4.3 数据同步

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sync/preferences` | 获取用户同步偏好 |
| PUT | `/api/sync/preferences` | 保存用户同步偏好 |
| POST | `/api/sync/run` | 启动数据同步，SSE 推送进度 |

#### SSE 事件格式（回测 & 同步通用）

```
data: {"type":"progress","phase":"拉取1h K线","current":50,"total":200,"percent":25.0}
data: {"type":"done","message":"回测完成"}
data: {"type":"error","message":"错误信息"}
```

---

## 5. 前端页面规范

### 5.1 整体布局

```
┌──────────────────────────────────────────────────────┐
│  [折叠] [展开]  侧边导航栏 (左)   │  主内容区 (右)   │
│                                   │                  │
│  ■ 标的展示                       │  当前视图内容    │
│  ■ 历史回测                       │                  │
│  ■ 数据同步                       │                  │
└──────────────────────────────────────────────────────┘
```

- **折叠态**：宽 56px，只显示 Lucide 图标
- **展开态**：宽 220px，显示图标 + 文字
- 切换动画：CSS transition 200ms
- 当前页面对应菜单项高亮

### 5.2 标的展示（SymbolsView）

沿用 `symbols.html` 全部功能：
- 左侧过滤栏：周期选择、策略筛选、搜索、重置
- 标的列表：支持排序（交易对 / stop_loss_pct / risk_reward_ratio）
- 右侧 K 线图（ECharts 蜡烛图 + 成交量 + MA 指标线）
- 点击标的 → 加载并展示 K 线

### 5.3 历史回测（BacktestView）

**左侧：策略列表**
- 列：策略名称 / 类型 / 创建时间 / 上次回测时间 / 上次收益率
- 操作：新建按钮 → 弹窗；行内：运行 / 删除
- 运行中显示 SSE 进度条

**新建策略弹窗（StrategyModal）**
- 策略名称（自动生成如 `MA策略_20260410_1`，用户可编辑）
- 策略类型下拉（可扩展）
- 动态参数表单（根据策略类型切换字段）：
  - 通用参数：初始资金、仓位比例（%）、时间框架、起止日期（必填）
  - MA+KDJ 专属：MA 周期组（30/60/120/240 可编辑）、KDJ J/K/D 阈值、止损系数、阶段止盈开关、冷却小时数、最大持仓数、最小盈亏比
- 参数校验（正整数、范围限制等）
- 确认创建

**右侧抽屉（ResultDrawer）**
- 点击策略列表某行"查看结果"后从右侧滑出
- 内容（自上而下）：
  1. 汇总统计卡片（总收益率 / 胜率 / 最大回撤 / 夏普比率 / 总交易数）
  2. 净值曲线（ECharts 折线图，X 轴时间 / Y 轴组合净值）
  3. 交易记录表（symbol / 买入时间 / 买入价 / 卖出时间 / 卖出价 / 盈亏% / 持仓周期）
  4. K 线图区域：点击交易记录某行 → 展示该标的回测区间 K 线，标注买卖点（▲▼）+ 动态止损止盈折线

### 5.4 数据同步（SyncView）

- 时间框架多选（1h / 4h / 1d 复选框）
- 标的列表（从 symbols.json 加载）：搜索过滤 + 全选/全不选 + 逐项勾选
- 用户选择自动保存到后端 `sync_preferences.json`
- "开始同步"按钮 → SSE 实时进度（阶段 + 进度条 + 百分比）
- 完成 / 错误状态展示

---

## 6. 约束与规范

| 项目 | 规范 |
|------|------|
| 单文件行数 | ≤ 500 行（Python / Vue SFC / JS 均适用） |
| 图标库 | Lucide Vue Next |
| 图表库 | ECharts 5 |
| API 通信 | REST + SSE（无 WebSocket） |
| 跨域 | 无（FastAPI 同时托管静态文件） |
| 数据存储 | 本地 JSON 文件（无数据库） |
| 回测参数 | 由 FastAPI 接收参数后注入 BacktestConfig，重构后不依赖全局常量 |
| 兼容性 | 删除 `serve_symbols.py` `serve_report.py`，启动命令统一为 `python main.py` 或 `uvicorn main:app` |

---

## 7. 启动方式（重构后）

```bash
# 后端
pip install fastapi uvicorn

# 前端构建
cd frontend
npm install
npm run build

# 启动
uvicorn main:app --host 0.0.0.0 --port 8000
# 访问 http://localhost:8000
```

开发模式：
```bash
# 终端1：后端热重载
uvicorn main:app --reload --port 8000

# 终端2：前端热更新（代理到 8000）
cd frontend && npm run dev
```

---

## 8. 迁移清单

| 文件 | 操作 |
|------|------|
| `serve_symbols.py` | ✗ 删除 |
| `serve_report.py` | ✗ 删除 |
| `symbols.html` | ✗ 删除（功能迁入 Vue 组件） |
| `backtest/config.py` | ✎ 重构为 `BacktestConfig` dataclass |
| `backtest_strategy.py` | ✎ 重构为 `run(config)` 函数 |
| `main.py` | ✚ 新建（FastAPI 入口） |
| `api/` | ✚ 新建 |
| `data/` | ✚ 新建 |
| `frontend/` | ✚ 新建（Vue3 + Vite 工程） |
