# 04 · 验证、风险核查点与实施顺序

## 实现前必查核查点（任何一条进硬断言/SQL 前先落源头）

| # | 核查点 | 影响 | 查法 |
|---|---|---|---|
| 1 | strategy 出场模式是否支持大盘 oamv 字段条件 | 出场配置 9（regime 恶化离场）可行性 | 读 simulator 出场求值路径；不支持则配置 9 挪二轮并做小扩展 |
| 2 | 大样本 run 的 `Math.max(...rets)` 栈溢出是否已修 | 宽锚点 run（可达百万级）能否跑完 | 查 `signal-stats.metrics.ts` 现状 + 相关交接文档；未修先修 |
| 3 | 单个宽锚点 run 实测耗时 | 18 个 run 的排程（串行/并行） | 跑第一个 run 计时后再定 |
| 4 | 入选过滤器含大盘细分字段时的映射扩展 | 真机收口可表达性 | 收口前往 `ASHARE_MARKET_AMV_COL_MAP` 加键 + 前端选项 |
| 5 | ~~条件系统 operator 是否含 `lte`~~ **已核（2026-06-11）** | 象限边界（`amv_macd <= 0`）真机表达 | `lte` 双处确认：`strategy-conditions.query-builder.ts:20`（`lte: '<='`）+ `dto/create-strategy-condition.dto.ts:3`（operator 联合类型含 `lte`）。边界口径四处（01 定义/02 SQL/真机条件/classifyRegime）统一 `<=` 归负侧 |
| 6 | 04L2 方案标的池配置 | 锚点 run 与基线可比性 | 建 run 前读 test `82f8eb52-…745b` 完整配置并复制 |

## 测试矩阵

| 层 | 内容 |
|---|---|
| 单测（后端） | `classifyRegime()` 纯函数（四象限+边界值+null 入参）；配置创建校验（缺象限/非法枚举/字段不在白名单/exit 参数组合）；run-daily 幂等（同日重跑先删后插）与 fail-closed（缺 oamv 行落 unknown 不扫描） |
| 研究侧自洽 | 每张离线结果表手工复核 `kelly = p - (1-p)/payoff`；count 预检 SQL 与 enumerator 口径比对 |
| 对账（硬验收） | 每象限胜者真机 run 的 `sample_count`/`kelly_f` 与离线逐位对账，差异须可解释，解释不了= bug |
| e2e | Phase 1：终选真机 run 全链路（建 test → run → 读结果）；Phase 2：选一个历史日跑 run-daily 全链路（识别→扫描→落库→前端显示），含 flat 象限日与缺数据日两个分支 |
| 既有门禁 | 后端 `jest` 全绿；前端 `type-check` + `lint:quant-lines`；migration `.sql`+`.ps1` 配对可执行 |

## 硬约束承袭（来自项目规范与前序教训）

- **过拟合纪律**：禁止在选出过滤器的同一段数据上报告 kelly 当结论（0.118→打平
  的教训）；双保险协议（02）是本 spec 的不可裁剪部分。
- **0AMV 数据**：如需补/改，一律全量 overwrite（`{startDate:'20210901',
  syncMode:'overwrite'}`，管理员会话）；禁小窗口 overwrite（段界漂移实测教训）。
- **源头验证**：列名/表名/run id/operator 进硬断言或 SQL 前，先 grep 实体或查
  真 DB 一条；禁止采信本 spec 或子代理的二手转述（本 spec 数据截至 2026-06-10）。
- **后端无热加载**：改 `apps/server` 后必须重启进程再做端到端验证。
- **Windows/GBK**：源文件 UTF-8；PowerShell 禁 `&&`；psql 输出数字异常时重查并
  自洽核验。
- 真机 API 调用走管理员浏览器会话（AuthGuard 全局）。

## 交付物与达标线

1. **阶段→策略映射表**（研究报告，落 `doc/研究/0amv-regime-strategy/`）：
   每象限三行（基线/空仓/胜者）× 指标（train kelly、holdout kelly、全期按年
   kelly/avg_ret、样本数、官方 run id）。胜者不达标的象限结论照实写「空仓」。
2. **诚实边界声明**（映射表附录）：哪些 edge 稳健（跨年一致）、哪些靠特定行情
   （如 Q1×2025）；holdout 仅为弱保护的三点事实（象限轴凭全周期选定、预验表
   已暴露各象限 holdout 期 kelly、入场族身份核心源自含 holdout 的全周期演化）
   必须写明；Q4×2022 正收益反例必须标注。
3. **`regime_strategy_config` v1**：机器可读配置实例，evidence 齐全，经配置
   校验通过并可被 Phase 2 激活。
4. **Phase 2 功能**：每日流水线 + API + 前端两处，测试矩阵全绿，历史日 e2e
   通过。
5. **预登记与对账记录**：`preregistration.md` 时间线完整、holdout 单次评估
   无重评（全局预算 12 次不超支）、`runs-manifest.md` 台账齐全、真机对账
   逐位记录。
6. **影子期终验报告**：config v1 激活后，以 2026-06 之后的每日流水线做
   ≥8 周 walk-forward 影子验证（唯一零接触数据窗），复核各象限实际信号
   前向表现，作为配置保留/降级依据。

## 实施顺序建议（里程碑）

```text
M0 核查点清扫（1/2/5/6 必须先于建 run；3 随首 run；4 随收口）
  ▼
M1 count 预检 + 16–18 个宽锚点 run 分批建跑（数量视核查点 1，排程视核查点 3）
  ▼
M2 离线搜索（族×出场×象限 切片 → 单变量 → 贪心组合 → 候选池）
  ▼
M3 预登记 top-3/象限 → holdout 单次评估 → 达标判定
  ▼
M4 真机收口 run + 逐位对账 → 映射表 + 边界声明 + config v1 成稿
  ▼
M5 Phase 2 实施（migration/实体/服务/API/前端）→ 测试矩阵 → 历史日 e2e
```

M2–M3 为纯研究操作（SQL + 日志），不产生生产代码改动；M0/M5 与可能的小扩展
（核查点 1/4）是代码改动集中处，互不相交，便于按文件域拆分任务。

**M5 可并行**：`regime_strategy_config` schema 已定死，M5 的 migration/实体/
服务/API/前端/单测可自 M1 起用**合成 draft 配置**并行推进；仅「激活 v1 +
真实历史日 e2e + 影子期启动」依赖 M4 完成。
