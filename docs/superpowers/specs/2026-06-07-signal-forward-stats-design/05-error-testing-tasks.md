# 05 · 错误处理、测试与实现任务

[← 返回 index](./index.md)

## 5.1 错误处理与 fail-fast

- **方案校验**（DTO + service）：见 [04 文档 §4.1](./04-api-and-frontend.md#41-dto)，模式必填字段缺失 → 400。
- **区间越界**：`dateStart/dateEnd` 超出 `trade_cal` 覆盖范围 → 400，提示可用范围。
- **run 失败**：模拟过程异常 → run 标 `status='failed'` + `error_message`，不静默吞（对齐 `.claude/rules/data-integrity.md` 禁 `.catch(()=>[])`）。

### 空数据与可观测

run 记录须显式暴露两类"伪装成功"，不得当作正常完成：
- **零信号**：买入条件在整个区间 0 触发 → `sample_count=0`，run 仍 `completed` 但带 warn 标记（前端提示"该条件区间内无触发"）。
- **全被过滤**：有触发但全被入场过滤剔除 → `filtered_count>0 && sample_count=0`，同样 warn。
- 每条被过滤的信号按原因计数（停牌/涨停/次新），汇总写入 run（或日志），便于诊断"为什么样本这么少"。

## 5.2 单测清单（jest）

`pnpm --filter @cryptotrading/server exec jest <pattern>`

1. **`signal-stats.metrics.spec.ts`（纯函数, 最关键）**：
   - 构造已知 `ret[]`（含正/负/零/全胜/全负/无亏损样本）手验：胜率 p、avg_win、avg_loss、赔率 b、profit_factor、凯利 f*。
   - 验证边界：`losses` 为空 → PF/b/kelly = null；`N=0` → 全 null；`ret=0` 不计 wins/losses 但计入 N。
   - 用例附手算注释（例：ret=[0.1,0.1,-0.05] → p=2/3, b=0.1/0.05=2, PF=0.2/0.05=4, f*=2/3-(1/3)/2=0.5）。
2. **`signal-stats.simulator.spec.ts`**：
   - `fixed_n`：T+1 开盘买、T+1+N 收盘卖，ret 口径正确；持有期停牌日 hold_days 不递增。
   - `strategy`：卖出条件首次命中日出场；满 max_hold 强平 exit_reason='max_hold'；退市强平。
   - 入场过滤边界：一字涨停(open>=up_limit)剔除、次新(<60交易日)剔除、停牌(无 T+1 行)剔除。
3. **`signal-stats.enumerator.spec.ts`**：卖出/买入条件锚定到指定交易日的 WHERE 生成正确；cross 算子跨日子查询复用正确。

mock 数据源用小型构造数据集，不连真 DB。

## 5.3 真机端到端验证

1. 跑 migration（`docker exec` 脚本），确认三表 + 索引建成。
2. **重启后端**（`nest start` 无 watch，新路由才生效）。
3. 建一个简单方案（如买入 `macd_hist cross_above 0`，fixed_n N=1，全市场，近一个月区间）触发 run。
4. **抽 1~2 笔 `signal_test_trade` 手算核对**：用 `docker exec ... psql` 查该 `(ts_code, signal_date)` 的 `qfq_open[buy_date]` 与 `qfq_close[exit_date]`，手算 `ret` 比对落库值。
5. 验证聚合：`docker exec` 查 trade 表手工聚合胜率，比对 `signal_test_run` 落库的 `win_rate`。
6. 前端：复用 `StrategyConditionBuilder` 配置 → 运行 → 进度轮询 → 指标卡 + 明细表显示正常（必要时 `browser-driving` 验证）。
7. `verification-before-completion`：所有"已通过"断言须附实际命令输出，不空口。

## 5.4 实现任务批次（按文件域切分，供 subagent-driven-development）

各 agent 修改**互不相交的文件域**，避免覆盖（不使用 worktree 隔离）。建议顺序：

| 批次 | 任务 | 文件域 | 依赖 |
|---|---|---|---|
| **B1** | 数据模型 | 3 实体 + migration `.sql`/`.ps1` + `app.module` entities 数组 + module forFeature | 无（先行） |
| **B2** | 指标纯函数 + 单测 | `signal-stats.metrics.ts` + `.spec.ts` | 无（可与 B1 并行） |
| **B3** | 模拟与枚举 + 单测 | `signal-stats.simulator.ts` / `enumerator.ts` + `.spec.ts`（复用 query-builder） | B1（实体类型） |
| **B4** | runner + service + controller + DTO | `signal-stats.{runner,service,controller}.ts` + `dto/` | B1/B2/B3 |
| **B5** | 前端 | `SignalStatsView.vue`(+ 拆分子组件) + 路由 + store + api client + shared-types | B4（API 契约） |

B1/B2 可并行起步；B3 依赖 B1 的实体类型；B4 汇总 B2/B3；B5 依赖 B4 的 API 契约。

**收尾**：分层 commit（对齐记忆 `feedback_layered_commits`，按子系统分多个语义清晰 commit：数据模型 / 指标 / 模拟 / API / 前端）；跑全量单测 + 前端 type-check + `lint:quant-lines`（若动 quant 目录，本功能不动）；真机端到端；按 `finishing-a-development-branch` 决定合并。

## 5.5 硬约束清单（带走）

- 不假设、暴露权衡、用中文（CLAUDE.md）。
- 进硬断言/SQL join 键的列名/表名/接口名必须落真 DB 或实体核对，子代理报告=二手（`.claude/rules/data-integrity.md`）。
- A 股口径：交易日历 `raw.trade_cal WHERE exchange='SSE' AND is_open=1`；前向收益用 `qfq_*`（已验证全填充）；停牌/涨停/次新过滤口径见 [02 文档](./02-simulation-and-semantics.md#入场过滤全开对齐-quant用户已确认两处简化)。
- 后端 `dev` 无 watch，改 `apps/server` 后必须重启进程。
- 新增 TypeORM 实体双注册（module forFeature + app.module entities）。
- DB schema 调整随附 `docker exec` 脚本（`.sql` + 同名 `.ps1`）。
- Vue 单文件 ≤500 行。
- 终端 PowerShell 禁 `&&` 用 `;`；终端 GBK 但源文件 UTF-8，文件 I/O 显式 `encoding='utf-8'`，对象键名用英文。
- 派 Explore 子代理显式传 `model: sonnet`。

[← index](./index.md)
