# 03 · Phase 2 自动化设计（每日识别 + 选股清单）

> **⚠️ 本 spec 为 v1 版本，已于 2026-07-05 被 regime 参数化改造覆盖。**
> 当前实现：
> - 象限数量、key、标签、分桶规则（match）完全由用户在 `regime_strategy_config.config` 中配置；
> - `config` 结构从 `Record<'Q1'|'Q2'|'Q3'|'Q4', RegimeConfigEntry>` 变为 `{ marketIndex: string; quadrants: QuadrantEntry[] }`；
> - 分桶条件作用域为大盘级字段（oamv_* + idx_*），由 `market-condition-evaluator` 统一求值；
> - 旧 `regime_daily_pick.regime` 列已扩至 `varchar(32)`，历史数据已清空。
> 本文件保留作为研究背景参考，具体实现以代码为准。

## 配置工件：`regime_strategy_config`（两阶段的契约）

新表 + TypeORM 实体。**schema 现在定死，研究产出填值**——自动化设计因此不含
TBD，未知的是数据值而非设计。

```text
regime_strategy_config
├─ id          uuid PK
├─ version     int UNIQUE
├─ status      varchar(10)  'draft' | 'active' | 'archived'（全表至多一个 active）
├─ note        text
├─ created_at  timestamptz
└─ config      jsonb（四象限齐全，结构如下）
```

`config` jsonb 结构（每个象限一个条目，Q1–Q4 必须齐全）：

```json
{
  "Q3": {
    "action": "trade",
    "label": "反弹筑底",
    "entryFamily": "brick",
    "entryConditions": [ { "field": "...", "operator": "...", "...": "..." } ],
    "exitMode": "trailing_lock",
    "exitParams": { "maxHold": null },
    "kellyFraction": 0.12,
    "evidence": {
      "trainKelly": 0.0,
      "holdoutKelly": 0.0,
      "byYear": { "2022": 0.0, "2023": 0.0 },
      "officialRunId": "uuid"
    }
  },
  "Q4": { "action": "flat", "label": "空头", "entryFamily": null,
          "entryConditions": null, "exitMode": null, "exitParams": null,
          "kellyFraction": 0, "evidence": { "...": "见研究日志" } }
}
```

要点：

- `entryConditions` 直接是条件系统的 JSON——研究胜者原样落进配置、扫描时原样
  执行，**没有翻译层**（含该象限的两条 oamv 大盘条件）。
- `action='flat'` 的象限其余策略字段为 null；`evidence` 仍须填（空仓也是有
  证据的结论）。
- `evidence` 固化双保险证据链，前端可展示"这条结论凭什么"。
- `kellyFraction` 取值规则 = 该象限胜者 holdout kelly × 0.5（半凯利折扣）；
  flat 象限恒为 0。**仅供前端展示仓位建议**，Phase 2 不据此执行任何动作。
- `exitMode/exitParams` 在 Phase 2 **仅作展示**（evidence 弹窗与人工执行
  参考），每日流水线只消费 `action` 与 `entryConditions`。
- migration 走仓库惯例：`apps/server/migrations/*.sql` + 同名 `.ps1`（内置
  `docker exec`）；实体**双注册**（module `forFeature` + `app.module` 根
  entities 数组——已知坑，漏后者编译绿但运行时 EntityMetadataNotFound 500）。

## 每日流水线

```text
0AMV 同步完成（既有 sync0amv）
  ▼
POST /api/regime-engine/run-daily?tradeDate=YYYYMMDD (admin)
  │   ←─ 手动触发为主；sync0amv 末尾自动钩子为可选增强（默认开关关闭）
  ▼
取 oamv_daily 当日行
  ├─ 缺行 ──▶ regime='unknown'，logger.warn(含 tradeDate)，不扫描，
  │           落一条 unknown 记录，前端亮黄牌（fail-closed）
  ▼ 有行
按 amv_dif/amv_macd 正负算象限
  │   （与离线 SQL 同一 CASE 口径，抽成纯函数 classifyRegime() + 单测）
  ▼
读 active 配置该象限条目
  ├─ 无 active 配置 ──▶ 409，提示先激活配置
  ├─ action=flat ──▶ 落一条"今日空仓"记录（regime + 空仓理由）
  └─ action=trade ─▶ 用 entryConditions 跑当日条件扫描
                       （复用 strategy-conditions 现有查询构建器）
                       ▼
                     候选清单落 regime_daily_pick
```

```text
regime_daily_pick
├─ id  uuid PK
├─ trade_date      varchar(8)
├─ regime          varchar(8)   'Q1'|'Q2'|'Q3'|'Q4'|'unknown'
├─ config_version  int NULL     （unknown 记录取当时 active 版本，无 active 则 null）
├─ action          varchar(8)   'trade'|'flat'|'unknown'
├─ ts_code         varchar(30)  （flat/unknown 行为 null）
├─ name            varchar(64)  （响应期注入，落库快照）
├─ snapshot        jsonb        （信号日关键字段快照：close、入场条件命中值等）
└─ created_at      timestamptz
UNIQUE(trade_date, config_version, ts_code)
```

- **幂等**：同 `trade_date` 重跑**按日全量先删后插**（删除该日全部记录后
  重建，含 NULL 版本行）。注意 UNIQUE 约束不覆盖 `ts_code` 为 NULL 的
  flat/unknown 行（Postgres 视 NULL 互不相等），这两类行的防重完全由
  删插语义保证。
- **不自动下单、不持仓跟踪**（决策 6）；清单供人决策。

## API 设计（全局 AuthGuard 下，写操作 admin）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/regime-engine/today` | 当前象限 + 生效配置摘要 + 最新一日清单 |
| GET | `/api/regime-engine/picks?tradeDate=` | 指定日清单（含 flat/unknown 记录） |
| GET | `/api/regime-engine/configs` | 配置列表（版本/状态/note） |
| POST | `/api/regime-engine/configs` | 新建 draft 配置（校验见下） |
| POST | `/api/regime-engine/configs/:id/activate` | 激活（原 active 自动转 archived，事务内） |
| POST | `/api/regime-engine/run-daily` | 触发当日流水线（admin；可传 tradeDate 回算历史日） |

配置创建校验（fail-fast）：四象限键齐全；`action` 枚举合法；trade 象限的
`entryConditions` 每个 field 必须命中条件系统字段白名单（三个 COL_MAP 的键集），
`exitMode/exitParams` 组合合法（如 fixed_n 必带 N）；校验失败 400 并指明字段。

## 前端设计

两处改动，均遵守单文件 ≤500 行：

1. **0AMV 面板加「当前象限」徽章卡**：Q1–Q4 着色徽章 + 生效策略一句话 +
   开仓/空仓状态；unknown 时黄牌提示数据缺失。数据源 `GET /today`。
2. **strategy 域新视图「regime 选股清单」**：日期选择器 + 象限标签 + 清单表
   （ts_code/名称/快照关键列）+ evidence 弹窗（展示该象限配置的 train/holdout/
   按年证据与官方 run id）。

```text
┌──────────────────────────────────────────────────┐
│ [日期: 2026-06-10 ▾]   当前象限: ● Q3 反弹筑底     │
│ 生效配置 v1 · 策略: 搬砖突破变体 · 状态: 开仓      │
├──────────────────────────────────────────────────┤
│ ts_code   名称     close   命中条件摘要   [证据]   │
│ 000001.SZ 平安银行  …       …             查看     │
│ …（清单表，空仓日显示"本象限空仓"及理由）          │
└──────────────────────────────────────────────────┘
```

## 模块落位

后端新增 `apps/server/src/strategies/regime-engine/`（module/controller/service +
`regime.classifier.ts` 纯函数），实体放 `entities/strategy/`。与 signal-stats
共享条件系统查询构建器，不复制查询逻辑。
