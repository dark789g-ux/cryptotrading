# 05 · 并行任务切分 + 验证门槛

← 返回 [`./index.md`](./index.md)

## 并行任务的无重叠文件域

按 brainstorming 规范：**不使用 git worktree 隔离**，所有 agent 在主工作目录改文件；
冲突靠"互不相交的文件域"从源头避免。

```text
Agent A · 后端实体 + 迁移
  文件域: apps/server/src/entities/active-mv/concept-amv-daily.entity.ts (新建)
          apps/server/migrations/20260602_concept_amv_daily.{sql,ps1} (新建)
  产出:   新表实体 + 迁移脚本 + 行数对齐校验（见 03 文档）

Agent B · 后端 service / controller / module / 类型
  文件域: apps/server/src/market-data/active-mv/**          (改)
          （AMV 类型在 active-mv/active-mv.types.ts，已含于上一行；shared-types 无 AMV 类型）
  产出:   ThsIndexAmvService 泛化 + resolveIndexCodes type 过滤 + concept 端点
          （见 02 文档）
  依赖:   import Agent A 新建的 ConceptAmvDailyEntity（仅 import 路径耦合，文件不重叠）

Agent C · 前端 API + 一键同步接线
  文件域: apps/web/src/api/modules/market/active-mv.ts        (改，本文件唯一归属 C)
          apps/web/src/components/sync/**                     (改/新建)
  产出:   activeMvApi 三个 concept 方法 + get/sync 全部 AMV 方法
          + useActiveMvSync + useOneClickSync 三步接线 + 步骤重命名（见 01 文档）

Agent D · 前端板块展示
  文件域: apps/web/src/components/money-flow/SectorFlowPanel.vue   (改)
          apps/web/src/components/money-flow/trendFetchers.ts       (改)
          apps/web/src/components/money-flow/FlowTrendModal.vue     (改)
  产出:   板块 tab 0AMV 副图（见 04 文档）
  依赖:   消费 Agent C 在 active-mv.ts 新增的 getConcept；D 不编辑 active-mv.ts
```

### 依赖与执行顺序

```text
A ──→ B        （B import A 的实体）
C ──→ D        （D 用 C 加的 activeMvApi.getConcept）
A/B 与 C/D 两条链可并行；本会话统一合并、按子系统分层 commit。
```

> 文件域唯一性自检：`active-mv.ts` 仅 C 改；`market-data/active-mv/**` 仅 B 改；
> `components/money-flow/**` 仅 D 改；`components/sync/**` 仅 C 改；新文件仅 A 建。无交叉写。

## 验证门槛（合并前逐项过）

### 后端

- `pnpm --filter @cryptotrading/server build` 通过。
- `pnpm --filter @cryptotrading/server exec jest active-mv`（含 resolveIndexCodes type 过滤用例）。
- 迁移执行后跑 03 文档 (a)~(d) 校验，全部达期望（concept 行数守恒、industry 无残留 N、signal 非空）。
- 接口手测：industry/sync 不传 tsCodes 只出 I；concept/sync 只出 N。

### 前端

- `pnpm --filter @cryptotrading/web type-check` 通过。
- `pnpm --filter @cryptotrading/web build`（vite）通过——**强制**，不可只信 type-check
  （记忆教训：SFC 编译错 type-check 查不出）。
- 触及的 `.vue` 守 500 行硬约束。

### 端到端（浏览器实看）

- 重启后端进程（`nest start` 无 watch，新路由不重启不生效——CLAUDE.md 硬约束）。
- `/sync` 一键同步选最近 3 个交易日：第 4/5/6 步 success 且写入 > 0，第 7 步标签为"大盘 0AMV"。
- `/money-flow` 板块 tab → 详情 → 0AMV 副图正常渲染。

### 数据完整性（data-integrity.md）

- `resolveIndexCodes` 的 `c.type=:type` 与迁移 WHERE 的 type 判定，写码前已亲查真 DB（非采信本 spec
  或子代理转述）。
- 同步 fetcher 返回 0 行：沿用现有 `*_empty` failedItems 机制，concept 空数据标 `concept_amv_empty`。

## 完成定义（DoD）

1. 一键同步含个股/行业/概念 AMV 三步（增量），大盘 0AMV 标签已正名。
2. `concept_amv_daily` 表存在，type='N' 数据已从 industry 表迁入，两表各自纯净（I / N 不再混）。
3. `industry/sync` 与 `concept/sync` 各按 type 计算，互不越界。
4. 前端板块 tab 展示概念 0AMV 副图（前提：ts_code 同源性已核实通过）。
5. 后端 build/jest、前端 type-check/vite build、浏览器实看、迁移校验全绿。
