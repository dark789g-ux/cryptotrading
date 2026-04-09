# AGENTS.md — cryptotrading 项目总览

> **L1（始终加载）**：全局概览。编写代码前先读对应子目录的 AGENTS.md（L2），按需读取源文件（L3）。

---

## 项目定位

基于币安 USDT 现货行情的完整本地流水线：**K 线采集 → 指标计算 → 本地回测 → HTML 可视化**

- 数据以 CSV 格式缓存在本地，零外部数据库依赖
- HTTP 服务仅使用 Python 标准库 `http.server`，无框架依赖

---

## 目录索引

| 路径 | 说明 | AGENTS.md |
|------|------|-----------|
| `backtest/` | 回测库（配置、数据加载、引擎、指标、模型、报告生成） | [→](backtest/AGENTS.md) |
| `cache/` | 本地 K 线 CSV 缓存（纯数据目录） | — |
| `backtest_results/` | 回测输出结果（纯数据目录） | — |
| `doc/` | 详细文档：脚本说明、编码规范、回测流程 | — |
| `test/` | 研究笔记与草稿 | [→](test/AGENTS.md) |
| `.cursor/` | Cursor IDE 规则与 Agent 技能配置 | [→](.cursor/AGENTS.md) |

---

## 典型工作流

```bash
python fetch_symbols.py       # 1. 更新交易对列表
python fetch_klines.py        # 2. 拉取 / 更新 K 线与指标
python backtest_strategy.py   # 3. 运行回测
python serve_report.py        # 4. 回测报告  → http://localhost:8888
python serve_symbols.py       # 5. 标的浏览  → http://localhost:8889
```

---

## 主要依赖

`pandas` · `requests` · `tqdm`

> `requirements.txt` 尚未创建，建议补全并固定各依赖版本。

---

## L2 延伸阅读

> 按需加载：只在任务涉及对应领域时读取，避免无关上下文干扰。

| 文档 | 何时阅读 |
|------|---------|
| [`doc/scripts.md`](doc/scripts.md) | 新增、修改或调用根目录任意脚本（`fetch_*.py` / `serve_*.py` / `backtest_strategy.py` 等）时 |
| [`doc/conventions.md`](doc/conventions.md) | 编写任意 `.py` 文件、读写 CSV、调用币安 API、或需要了解 CSV 列定义时 |
| [`doc/backtest_flow.md`](doc/backtest_flow.md) | 涉及回测逻辑、策略信号、仓位管理、止盈止损或报告生成时 |
| [`backtest/AGENTS.md`](backtest/AGENTS.md) | 修改 `backtest/` 目录下任意模块时 |
| [`doc/binance-rate-limit.md`](doc/binance-rate-limit.md) | 新增或修改任何发起币安 REST 请求的代码时（限速规范、429/418 处理、指数退避、并发限制） |
