# 信号方案迷你回测升级 + 量化任务草稿态 —— 设计总入口

> 日期：2026-06-14　|　状态：设计待实现　|　范围：两块独立子系统（Part A / Part B）

## 一句话背景

起点是一个小诉求：组合源选择器内联弹窗的「创建并运行」按钮应当**只创建参数、点「运行」才运算**（全站统一「先建后跑」）。在 brainstorming 中范围逐步明确为两块：

- **Part A（大）**：把「信号前向统计 signal_test」升级成**带资金账户的迷你回测**，配置用照「新建策略」形态的**7-tab 表单（见 [05 §5.1](./05-minibacktest-frontend.md)）**承载；并移除组合源选择器的「内联新建信号源」入口。
- **Part B（小，独立）**：量化任务队列 `ml.jobs` 新增 `draft` 草稿态，三个触发入口默认「保存草稿」，jobs 列表「运行」按钮才真正入队执行。

两块**无共享文件**，可独立实现、独立验证、独立合并。

## 核心结论（决定整份设计成立的三件事）

1. **迷你回测不造新引擎**：它＝「现有出场模拟纯函数核」（产出每笔 `ret`）＋「现有 portfolio-sim 引擎纯函数 `runPortfolioSim`」（拿 `ret` 做资金账户逐日回放）两段已存在代码的 **in-process 接线**。详见 [./02-minibacktest-architecture.md](./02-minibacktest-architecture.md)。
2. **依赖是单向、非循环**：signal_test 先枚举+模拟出场得到 `ret` → 再喂 `runPortfolioSim`。后者只消费已有 `ret`，不重算路径。
3. **backtest（crypto K 线）引擎不可复用**：数据模型/口径根本不兼容，已排除（[./01-background-scope-reuse.md](./01-background-scope-reuse.md) §三引擎）。

## 子文档清单与阅读顺序

| 顺序 | 文档 | 内容 |
|------|------|------|
| 1 | [01-background-scope-reuse.md](./01-background-scope-reuse.md) | 诉求演化与决策链、最终范围边界、三引擎复用结论（为什么这么设计） |
| 2 | [02-minibacktest-architecture.md](./02-minibacktest-architecture.md) | Part A 核心：两段接线架构、数据流、in-process 引擎复用、对拍恒等 |
| 3 | [03-minibacktest-data-model.md](./03-minibacktest-data-model.md) | Part A 存储：`signal_test.backtest_config` + `signal_test_run` 新列 + `signal_test_equity` 新表 + migration |
| 4 | [04-minibacktest-backend.md](./04-minibacktest-backend.md) | Part A 后端：runner 接线点、config DTO/校验、排序因子取数依赖、错误处理 |
| 5 | [05-minibacktest-frontend.md](./05-minibacktest-frontend.md) | Part A 前端：7-tab 表单控件复用映射、详情页净值曲线、移除内联新建源 |
| 6 | [06-job-drafts.md](./06-job-drafts.md) | Part B 全栈：`ml.jobs` draft 态 + dispatch endpoint + 三入口 + jobs 列表运行按钮 |
| 7 | [07-phasing-verification.md](./07-phasing-verification.md) | M0–M5 阶段拆分、任务文件域切分、验证门禁与 e2e 剧本 |

## 阶段规划速览（详见 07）

```text
M0  schema: signal_test.backtest_config + run新列 + equity新表 (NestJS migration)
                                          + ml.jobs draft (Python alembic)
M1  Part A 后端引擎接线: runner ⑤⑥⑦ (复用 PortfolioSimLoader.load + runPortfolioSim in-process + 落库) + config DTO/校验
M2  Part B 后端: ml.jobs draft + POST /quant/jobs/:id/dispatch
M3  Part A 前端: signal_test 7-tab 表单(复用 portfolio-sim 控件) + 详情页净值曲线
M4  Part B 前端: 草稿提交 + jobs 列表运行按钮; 并移除内联新建源(PortfolioSimNewSourceModal)
M5  e2e + 对拍: 单源 anchorMode 恒等(realizedRetNet ≡ ret) + 全链路真机
```

## 引用约定

- 跨文档引用统一用相对路径，章节号写在链接文字里（如 `[03 §3.2](./03-minibacktest-data-model.md)`）；锚点 slug 因渲染器而异，不在跨文档链接里硬编码。
- 代码引用统一 `file:line`（相对仓库根），如 `apps/server/src/strategy-conditions/portfolio-sim/portfolio-sim.engine.ts:122`。
- 所有进 migration / 硬断言的 schema 事实均已落实体定义 + 真 DB 核实（见 03 §核实基线）。

## 硬约束（贯穿全设计）

- 单文件 ≤500 行（`apps/web/src/views/quant/**`、`components/quant/**` 由 `lint:quant-lines` CI 强制）。
- 所有源文件 UTF-8；文件 I/O 显式 `encoding='utf-8'`；对象键名英文。
- DB 时间列 `timestamptz`；schema 变更走 migration（`synchronize:false`）。
- 后端 `dev` 无 watch，改 `apps/server` 须重启进程再验证。
- 改 `.vue` 合并前至少跑一次 `vite build`（type-check 查不出 SFC 编译错）。
- 子代理/摸底报告属二手信息，进硬断言前自查实体/真 DB。
