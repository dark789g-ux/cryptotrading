# AGENTS.md — cryptotrading 项目总览

> **L1（始终加载）**：全局概览。编写代码前先读对应子目录的 AGENTS.md（L2），按需读取源文件（L3）。

---

## 项目定位

基于币安 USDT 现货行情的完整本地流水线：**K 线采集 → 指标计算 → 本地回测 → Web 可视化**

- 数据以 CSV 格式缓存在本地，零外部数据库依赖
- Web：**FastAPI**（`/api`）+ **Vue 3**（`frontend/`），统一端口见 `main.py`

---

## 目录索引

| 路径 | 说明 | AGENTS.md |
|------|------|-----------|
| `backtest/` | 回测库（配置、数据加载、引擎、指标、模型、报告生成） | [→](backtest/AGENTS.md) |
| `cache/` | 本地 K 线 CSV 缓存（纯数据目录） | — |
| `backtest_results/` | 回测输出结果（纯数据目录） | — |
| `doc/` | 详细文档：脚本说明、编码规范、回测流程、前端规格 | — |

---

## 典型工作流

```bash
python fetch_symbols.py       # 1. 更新交易对列表
python fetch_klines.py        # 2. 拉取 / 更新 K 线与指标
python backtest_strategy.py   # 3. 运行回测
```

> **⚠️ 开发期**：运行 `start.ps1`，浏览器打开 **`http://localhost:5173`**（Vite dev server）。  
> 不要打开 `:8000`——后端挂载的是 `frontend/dist`（构建产物），开发时不实时更新。  
> Vite 已配置 `/api → :8000` 代理，前后端数据流正常。

---

## 用户偏好（协作方式）

| 主题 | 偏好摘要 |
|------|----------|
| 需求与交付 | 产品/UI/API 形态未说清时，**先问答澄清再写代码**；必要时多轮直到无歧义 |
| 需求文档 | 定稿级说明写入 **`prd/`**，便于对照实现与验收 |
| 后端与数据 | **FastAPI**；处理 CSV 用 **pandas** |
| 前端 | **Vue SPA**；旧静态页迁移完成后删除，避免双轨 |
| 交互默认值 | 倾向**显式控件触发**（按钮提交）；表格/布局类 **localStorage** 记忆 |
| API 形态 | 简单只读用 **GET**；带复杂筛选体用 **POST JSON** |
| 脚本 | 参数写在文件内；文件头 `# -*- coding: utf-8 -*-`；PowerShell 不用 `&&` |
| 语言 | 自然语言以**中文**回复 |

---

## 前端技术偏好（速查）

**Naive UI + Vue 3**，毛玻璃视觉风格，默认深色模式，ECharts 图表。  
样式规范、K 线图细节、踩坑记录 → 详见 [`doc/frontend-spec.md`](doc/frontend-spec.md)

---

## 主要依赖

`pandas` · `requests` · `tqdm` · `fastapi` · `uvicorn`

---

## L2 延伸阅读（按需加载）

| 文档 | 何时阅读 |
|------|---------|
| [`doc/scripts.md`](doc/scripts.md) | 新增、修改或调用根目录任意脚本时 |
| [`doc/conventions.md`](doc/conventions.md) | 编写任意 `.py` 文件、读写 CSV、调用币安 API 时 |
| [`doc/backtest_flow.md`](doc/backtest_flow.md) | 涉及回测逻辑、策略信号、仓位管理、止盈止损或报告生成时 |
| [`backtest/AGENTS.md`](backtest/AGENTS.md) | 修改 `backtest/` 目录下任意模块时 |
| [`doc/binance-rate-limit.md`](doc/binance-rate-limit.md) | 新增或修改任何发起币安 REST 请求的代码时 |
| [`doc/frontend-spec.md`](doc/frontend-spec.md) | 编写或修改 `frontend/src/` 下任意代码时 |
