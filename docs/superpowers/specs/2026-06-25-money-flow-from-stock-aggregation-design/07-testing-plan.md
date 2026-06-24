# 07 测试计划

## 7.1 后端单元测试

### `IndexWeightSyncService`

| 测试项 | 预期 |
|---|---|
| 首次同步生成版本 | `index_weight` 插入新行，`expire_date` 为 `NULL` |
| 成分无变化时跳过 | 不生成新版本，返回 `skipped: true` |
| 成分变化时版本切换 | 旧版本 `expire_date` 被设置为生效日前一天，新版本 `effective_date` 为最新权重日 |
| 多指数并行同步 | 各指数版本独立，不互相覆盖 |

### `MoneyFlowAggregationService`

| 测试项 | 预期 |
|---|---|
| 申万行业聚合 | 构造 3 只股票同属一个申万三级行业，验证 `money_flow_industries.net_amount` = 三者之和 |
| 同花顺行业聚合 | 构造 1 只股票属于 2 个同花顺行业，验证两个行业都正确加总 |
| 同花顺概念聚合 | 构造 1 只股票属于 2 个概念，验证两个概念都正确加总 |
| 宽基指数 PIT 聚合 | 构造 `index_weight` 两个版本，验证交易日取到正确版本 |
| 全市场大盘聚合 | 构造 5 只股票，验证 `money_flow_market.net_amount` = 总和 |
| 缺失个股资金 | 成分股当日无 `money_flow_stocks` 记录时，`SUM` 自动忽略（`NULL` 不参与） |

### `ASharesSyncService` / `a-shares-sync-fetchers`

| 测试项 | 预期 |
|---|---|
| `syncSymbols` 回填申万字段 | 同步后 `a_share_symbols.sw_industry_l3_code` 非空率符合预期 |
| 无 `raw.index_member` 映射的股票 | 新字段为 `NULL`，不报错 |

## 7.2 前端单元测试

### A 股指数面板

| 测试项 | 预期 |
|---|---|
| 新增资金流列可见 | `net_amount` / `buy_lg_amount` 等列默认可选中 |
| 列设置持久化 | 勾选资金流列后刷新，列状态保留 |
| 远程排序 | 点击资金流列表头，请求带 `sort` 参数 |
| 不同指数类型取对表 | 申万区取 `money_flow_industries`，同花顺行业区取 `money_flow_ths_industries` |

### A 股个股面板

| 测试项 | 预期 |
|---|---|
| 三级行业列渲染 | `swIndustryL1Name` / `L2Name` / `L3Name` 正确显示 |
| 原 `industry` 列消失 | 列定义中无 `industry` key |
| 三级行业筛选 | 选择一级行业后，查询参数正确，后端返回过滤结果 |

### `/money-flow` 删除

| 测试项 | 预期 |
|---|---|
| 路由 404 | `/money-flow` 不再可访问 |
| Sidebar 无入口 | 左侧导航无资金流向菜单 |

## 7.3 集成 / 端到端测试

### 一键同步全流程

| 测试项 | 方法 |
|---|---|
| 选近 5 个交易日跑一键同步 | 真机点击，观察 Step 2 各 phase 进度 |
| 验证聚合表有数据 | 同步后查 `money_flow_industries` / `sectors` / `market` / `index` |
| 验证 `index_weight` 版本生成 | 查 `market_index_scope` 中指数的 `index_weight` 记录 |

### 数据一致性校验

| 校验项 | SQL 示例 |
|---|---|
| 大盘 = 个股之和 | `SELECT trade_date, m.net_amount, (SELECT SUM(net_amount) FROM money_flow_stocks WHERE trade_date=m.trade_date) AS s FROM money_flow_market m` |
| 申万行业 = 个股之和 | 抽样某 `ts_code` + `trade_date`，交叉验证 |
| 宽基指数 = 成分股之和 | 抽样某指数 + 交易日，按 `index_weight` PIT 版本加总验证 |

### 复盘日报

| 测试项 | 预期 |
|---|---|
| 生成日报不报错 | `snapshot-builder` 能正确取 `market.netIn` |
| 行业/概念排名 | `industryRank` / `conceptRank` 从 `index_daily_quotes` 取 `pct_change` 正常 |

## 7.4 性能测试

| 测试项 | 目标 |
|---|---|
| 一键同步 Step 2 耗时 | 近 5 个交易日，Step 2 总耗时 < 10 分钟（含 index_weight + 个股 + 聚合） |
| A 股指数面板首屏加载 | 带资金流列，首屏请求 < 1 秒 |
| 历史重算 1 年 | 脚本在 30 分钟内完成 |

## 7.5 上线后监控

| 监控项 | 方式 |
|---|---|
| 同步失败率 | 一键同步 Step 2 `failed` 状态报警 |
| 聚合数据一致性 | 每日跑校验 SQL，差异 > 1% 报警 |
| `index_weight` 版本漂移 | 月中检测成分变化，异常变化 warn |
| 前端错误 | Sentry / 控制台错误监控 |
