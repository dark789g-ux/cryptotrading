# CryptoTrading

币安 USDT 现货量化交易回测系统。提供 K 线数据同步、技术指标计算、策略回测，以及基于 FastAPI + Vue3 的可视化 Web 界面。

---

## 功能概览

- **数据同步**：从币安 REST API 批量拉取 1h / 4h / 1d K 线，支持增量更新
- **指标计算**：MA、KDJ、MACD、布林带、止损价、风险回报比等
- **策略回测**：多标的并行回测，支持多仓位、止盈止损、冷却期、连续亏损保护
- **可视化界面**：三页 SPA，K 线图、策略 CRUD、回测结果抽屉、SSE 实时进度

---

## 技术栈

| 层次 | 技术 |
|------|------|
| 后端 | Python 3.11+、FastAPI、pandas |
| 前端 | Vue 3 + Vite、ECharts 5、Lucide Vue Next |
| 数据源 | 币安公开 REST API |

---

## 目录结构

```
.
├── main.py                   # FastAPI 入口，挂载所有路由与静态前端
├── api/
│   ├── symbols.py            # 标的列表与 K 线数据接口
│   ├── backtest_api.py       # 策略 CRUD 与回测执行接口（SSE 进度）
│   └── sync_api.py           # K 线数据同步接口（SSE 进度）
├── backtest/
│   ├── config.py             # 全局常量、BacktestConfig dataclass
│   ├── data.py               # K 线加载与预处理
│   ├── engine.py             # 回测主循环
│   ├── signal_scanner.py     # 入场信号检测
│   ├── position_handler.py   # 仓位管理与止盈止损
│   ├── cooldown.py           # 冷却期逻辑
│   ├── loss_tracker.py       # 连续亏损追踪
│   ├── indicators.py         # 指标计算（MA、KDJ、MACD）
│   ├── models.py             # 数据模型
│   ├── report.py             # 回测报告生成
│   └── trade_helper.py       # 交易辅助函数
├── backtest_strategy.py      # 回测入口（可直接运行，也可由 API 调用）
├── fetch_klines.py           # K 线数据抓取脚本
├── fetch_symbols.py          # 标的列表抓取脚本
├── kline_indicators.py       # 指标计算工具函数
├── patch_klines_indicators.py# 补全已有 CSV 中缺失指标
├── update_indicators.py      # 批量更新全部 CSV 指标
├── frontend/                 # Vue3 + Vite 前端
│   └── src/
│       └── views/
│           ├── SymbolsView.vue   # 标的展示页
│           ├── BacktestView.vue  # 历史回测页
│           └── SyncView.vue      # 数据同步页
├── cache/                    # K 线 CSV 缓存（不提交）
│   ├── 1h_klines/
│   ├── 4h_klines/
│   └── 1d_klines/
├── data/
│   ├── strategies.json       # 策略配置存储
│   └── sync_preferences.json # 用户同步偏好
└── backtest_results/         # 回测输出（不提交）
```

---

## 快速开始

### 1. 安装依赖

```bash
pip install fastapi uvicorn pandas requests
```

### 2. 构建前端

```bash
cd frontend
npm install
npm run build
cd ..
```

### 3. 启动服务

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

访问 [http://localhost:8000](http://localhost:8000)

### 4. 前端开发模式（热更新）

```bash
cd frontend && npm run dev   # 代理到 :8000
```

---

## 页面说明

| 路径 | 页面 | 功能 |
|------|------|------|
| `/symbols` | 标的展示 | 关键字 + 指标条件检索、服务端分页/排序、K 线图 |
| `/backtest` | 历史回测 | 策略 CRUD、执行回测、实时进度、结果抽屉 |
| `/sync` | 数据同步 | 多选标的与时间框架、同步进度实时推送（SSE） |

---

## 回测策略说明

默认策略（可在 `/backtest` 页面自定义）：

- **入场**：`close > MA60` 且 `MA30 > MA60 > MA120`，且 `close > MA240`，且 `KDJ.J < 10`，下一根 K 线开盘买入
- **仓位**：最多 2 个仓位，每仓 40%；两仓均阶段止盈后允许开第 3 仓
- **止盈**：最高价突破近期高点时卖出一半
- **止损**：近期低价止损 / 第 3 周期后收盘低于成本 / 第 5 周期后 MACD 方向未上升 / MACD 方向变化浮动止损
- **冷却期**：连续亏损后自动冷却，逐步恢复

---

## 数据同步流程

```
fetch_symbols.py            # 拉取全部 USDT 交易对列表
    ↓
fetch_klines.py             # 批量下载 K 线并计算技术指标
    ↓
patch_klines_indicators.py  # 补全旧 CSV 中缺失的指标列
    ↓
cache/{timeframe}_klines/   # 带指标的 K 线 CSV
```

---

## 主要 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/symbols/kline-columns?interval=` | 某周期 K 线 CSV 表头并集 |
| GET | `/api/symbols/names?interval=` | 交易对文件名列表（轻量） |
| POST | `/api/symbols/query` | 分页查询标的（JSON：筛选、排序、返回列） |
| GET | `/api/klines/{interval}/{symbol}` | 获取 K 线 CSV 文本 |
| GET | `/api/strategies` | 获取策略列表 |
| POST | `/api/strategies` | 创建策略 |
| PUT | `/api/strategies/{id}` | 更新策略 |
| DELETE | `/api/strategies/{id}` | 删除策略 |
| POST | `/api/backtest/{strategy_id}/run` | 触发指定策略回测 |
| GET | `/api/backtest/{strategy_id}/result` | 获取回测结果 JSON |
| GET | `/api/sync/preferences` | 获取同步偏好 |
| PUT | `/api/sync/preferences` | 保存同步偏好 |
| POST | `/api/sync/run` | 触发数据同步（SSE 进度） |
