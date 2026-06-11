# 03 · 数据模型与 API

## 表设计（public schema，NestJS migration 惯例）

Migration：`apps/server/migrations/20260611_create_portfolio_sim.sql` + 同名 `.ps1`
（内置 `docker exec` 调用，仓里既有配对先例）。实体放
`apps/server/src/entities/strategy/`，**双注册**（module `forFeature` + app.module 根
entities 数组，缺一编译绿但运行时 EntityMetadataNotFound）。

### portfolio_sim_run（一次模拟一行：配置快照 + 运行态 + 汇总指标）

| 列 | 类型 | 说明 |
|---|---|---|
| id | uuid PK DEFAULT gen_random_uuid() | |
| name | varchar(100) NOT NULL | |
| note | text NULL | |
| config | jsonb NOT NULL | 完整快照：sources[]（含解析后 runId）、initialCapital、解析后费率、anchorMode |
| status | varchar(16) NOT NULL DEFAULT 'pending' | pending / running / success / failed |
| phase | varchar(16) NULL | loading / replaying / writing |
| progress_done | int NOT NULL DEFAULT 0 | |
| progress_total | int NOT NULL DEFAULT 0 | 每阶段重置 |
| error_message | text NULL | |
| final_nav / total_ret / annual_ret | numeric NULL | 成功后回填 |
| max_drawdown / sharpe / calmar | numeric NULL | calmar 回撤为 0 时 NULL |
| daily_win_rate / daily_kelly | numeric NULL | 日收益口径（calcSignalStats） |
| n_taken / n_skipped | int NULL | |
| total_costs | numeric NULL | 买卖费用合计（绝对额） |
| anchor_check | jsonb NULL | 锚点对账：{pass, kellyOfficial, kellyReplayed, winOfficial, winReplayed, nOfficial, nReplayed} |
| created_at | timestamptz NOT NULL DEFAULT now() | |
| completed_at | timestamptz NULL | |

### portfolio_sim_daily（每日净值，~1100 行/run）

| 列 | 类型 |
|---|---|
| id | bigserial PK |
| run_id | uuid NOT NULL FK→portfolio_sim_run(id) ON DELETE CASCADE |
| trade_date | varchar(8) NOT NULL |
| nav / cash / daily_ret / exposure | numeric NOT NULL（exposure = Σ持仓市值/NAV(d)，收盘口径比率） |
| position_count | int NOT NULL |
| strategy_exposure | jsonb NOT NULL（{label: Σ该策略市值/NAV(d)}，收盘口径） |

注意口径区分：exposureCap 是**开仓时点**约束（分母 NAV_ref(d)，见 02）；本表两个
敞口列是**收盘口径**快照——持仓市值漂移可使收盘敞口轻微越过 cap，属正常现象非违规，
审计时以开仓时点判定为准（fill 行已存判定结果）。

UNIQUE (run_id, trade_date)。

### portfolio_sim_fill（逐信号判定，成交+弃单全量，~67k 行/官方双源 run）

| 列 | 类型 | 说明 |
|---|---|---|
| id | bigserial PK | |
| run_id | uuid NOT NULL FK CASCADE | |
| source_run_id | uuid NOT NULL | 源 signal_test_run |
| source_label | varchar(50) NOT NULL | |
| ts_code | varchar(30) NOT NULL | |
| signal_date / buy_date | varchar(8) NOT NULL | |
| status | varchar(8) NOT NULL | 'taken' / 'skipped' |
| skip_reason | varchar(16) NULL | already_held / slots_full / exposure_cap / cash_short |
| rank_field | varchar(16) NULL | |
| rank_value | numeric NULL | 缺失即 NULL（降级标记） |
| weight_entry / alloc | numeric NULL | taken 行 |
| exit_date | varchar(8) NULL | taken 行 |
| realized_ret_net / costs_paid | numeric NULL | taken 行（税后口径见 02） |

索引：(run_id, status)、(run_id, buy_date)。

弃单全量落库是刻意设计：验证标准"约束收紧→成交单调不增且弃单符合排序规则"逐行可审计；
影子期实盘也要能回答"那天为什么没买这只"。体量靠 DELETE run 级联清理控制。

## API（`/api/portfolio-sims`，`@AdminOnly` 对齐 regime-engine）

| 方法+路径 | 语义 |
|---|---|
| POST `/portfolio-sims` | 新建（name+note+config）；DTO 校验见 02；返回 201+实体 |
| GET `/portfolio-sims` | 分页列表（状态/汇总指标），按 created_at 倒序 |
| GET `/portfolio-sims/:id` | 详情（config+汇总+anchor_check） |
| POST `/portfolio-sims/:id/run` | 触发；**per-id 互斥**：running 中再触发 → 409，中文原文透传 |
| GET `/portfolio-sims/:id/progress` | {status, phase, progressDone, progressTotal, errorMessage}（2s 轮询） |
| GET `/portfolio-sims/:id/daily` | 全量每日行（~1100 行一次返回，前端画曲线） |
| GET `/portfolio-sims/:id/fills` | 服务端分页+筛选（status / sourceLabel / 日期段 / skip_reason），排序白名单 |
| DELETE `/portfolio-sims/:id` | 运行中拒绝（409）；级联清 daily/fills |

**触发与幂等**：POST :id/run 时①核 sources 各 runId 存在且 status='success' 且
trades>0（fail-fast，错误中文）；②置 running 后异步执行；③执行起点**事务内**删除该
run_id 旧 daily/fills 再写（重跑幂等，对齐 regime replaceDayPicks 先例）。
runner 完成时必须把 progress 推到终态（吸取 kelly_sweep "完成未发 100 卡 99" 教训）。

**源 run 的选择**：前端选 signal-stats **方案**（GET `/api/signal-tests` 既有接口），
服务端解析该方案最新 success run id 冻入 config；高级模式允许直接粘 run id
（从 runs-manifest.md 台账复制）。两种来源最终都以解析后的 run id 落快照。

## 模块结构（apps/server/src/strategy-conditions/portfolio-sim/）

```text
portfolio-sim/
├─ portfolio-sim.module.ts          forFeature 三实体 + providers
├─ portfolio-sim.controller.ts      8 路由（上表）
├─ portfolio-sim.service.ts         CRUD + 触发互斥 + 查询
├─ portfolio-sim.runner.ts          异步编排：装载→引擎→落库，三阶段进度上报
├─ portfolio-sim.loader.ts          DB 装载：trades / qfq 行情预取 / rank JOIN
├─ portfolio-sim.engine.ts          纯函数引擎核（不碰 DB，单测主战场）
├─ portfolio-sim.cost.ts            成本模型纯函数（含印花税时变）+ 三档预设
├─ portfolio-sim.types.ts           Config/Source/CostModel/EngineResult 类型
└─ dto/                             CreatePortfolioSimDto / ListFillsQueryDto
```

每文件 ≤500 行（仓规）；TypeORM numeric 列水合为 string，service/前端边界统一
parseFloat（signal-stats 既有惯例）。app.module 根 entities 数组追加三实体。
后端无热加载：**联调前必须重启 server 进程**。
