# 03 · 测试 / 风险 / 任务拆分

> 上游：[02-frontend.md](./02-frontend.md) ｜ 返回：[index.md](./index.md)

## 1. 测试矩阵

### 后端单测（`preferences.service.spec.ts` 改写）

- `getTableColumns`：无行 → 返回 `{table:[],split:[]}`；有行 → 返回 sanitize 后值。
- `saveTableColumns`：首存 INSERT（`newId` id）、复存 UPDATE 同行；sanitize 过滤非法 item。
- controller 白名单：合法 tableId 透传；非法 tableId → `BadRequestException`（400）。

### 前端单测（vitest）

- 通用 composable spec：`load()` 调 `getTableColumns(tableId)`、`save()` 调 `saveTableColumns(tableId, ...)`；`reset`/`setColumnVisible`/`moveColumn` 行为不回退。
- 改 mock：现有 `useSymbolColumnPreferences.usStocks.spec.ts` + 各 `*Panel.spec.ts`（`getSymbolsView`→`getTableColumns`）。
- 自选股/回测表 composable 若有 spec 一并改；无则新增最小覆盖（load→默认、save→调 API）。

### 迁移脚本验证（真 DB）

- 迁移前查 value 形态（`01` §4 前置核对）。
- 跑后查：拆出行数对齐、旧行仍在（`01` §4 验证 SQL）。
- 幂等：重跑一次，行数不变（`colmig:` 确定性 id + `ON CONFLICT DO NOTHING`）。

### 真机 e2e（派 browser-tester，后端重启后）

- **7 表逐个**："改列设置→保存→刷新/重进页面→列保留"。
- **迁移回归**：用迁移前已存过列偏好的老用户账号，确认 5 表设置原样保留（不回默认）。
- 自选股/回测表额外确认"换浏览器/无痕窗口登录同账号→列设置跟随"（用户级生效证据）。

## 2. 风险与缓解

| 风险 | 缓解 |
|---|---|
| **回归 5 个稳定表**（改了持久化链路） | 通用 composable 返回值接口零变更；逐个真机回归 7 表 |
| 迁移丢数据 | 旧行保留不删 + `.down.sql` 按 `colmig:` 前缀回滚；迁移前查样本形态 |
| 极老数据 scope 为数组（非对象） | 迁移前置核对必查 `jsonb_typeof`，命中则加数组分支 |
| 同步→异步首帧闪烁 | 默认列兜底 + load 后覆盖；e2e 确认无闪烁回退 |
| 自选股 store 列偏好有隐藏消费方 | 实现前 grep 全部引用（`02` §3.4），有则一并迁 |
| 后端改完未重启致 e2e 撞旧码 | e2e 前必重启后端（`nest start` 无 watch，见 CLAUDE.md） |
| `@/api` 删类型遗漏引用 | grep `SymbolsViewColumnPreferences` 全仓清零后再 build |

## 3. 任务拆分（subagent 派发）

按"独立文件域 / 互不相交修改范围"切分，避免并行覆盖。**不使用 worktree 隔离**，全部在主工作目录改，主线程负责集成与提交。

```text
依赖关系:
  T1(后端) ──┐
  T2(迁移)  ──┼──▶ T6(集成验证, 主线程编排)
  T3(前端底座)─┬─▶ T4(5老消费方) ─┐
               └─▶ T5(两表迁移)  ─┴──▶ T6
  T1/T2/T3 可并行起步；T4/T5 依赖 T3；T6 依赖全部
```

| 任务 | subagent | 职责边界（文件域） | 依赖 |
|---|---|---|---|
| **T1 后端接口** | general-purpose | `preferences.service.ts`（删旧 symbols-view 三件套、加 per-table get/save + 白名单 + `EMPTY_SCOPE_VIEW`）、`preferences.controller.ts`（删旧、加 `columns/:tableId` GET/PUT + 400 校验）、`preferences.service.spec.ts` 改写 | 无 |
| **T2 数据迁移** | general-purpose | 产出 **4 个文件**：`migration/20260626XXXXXX-generalize-column-preferences.sql` + 同名 `.ps1` + `.down.sql` + `.down.ps1`（内容按 `01` §4）；**只产出脚本、不执行**（执行在 T6 真 DB 跑） | 无 |
| **T3 前端底座** | general-purpose | API 层 `preferences.ts` + `@/api` 桶（删旧类型/方法、加 `getTableColumns/saveTableColumns`）；`useSymbolColumnPreferences.ts`→`useTableColumnPreferences.ts` 改名+重构（单表状态、删补全逻辑、接口不变） | 无（前端公共底座） |
| **T4 五个老消费方** | general-purpose | 5 个 `*Panel.vue` 改函数名+import+tableId；对应 `*Panel.spec.ts` + `useSymbolColumnPreferences.usStocks.spec.ts` 改 mock | T3 |
| **T5 两表迁移** | general-purpose | `useWatchlistColumnPreferences.ts` + `stores/watchlist.ts`（删 localStorage 列偏好逻辑，先 grep 消费方）+ WatchlistTable；`useBacktestMetricsColumnPreferences.ts` + `CandleRunSymbolMetrics`；相关 spec | T3 |
| **T6 集成验证** | 主线程 + browser-tester | 后端 build + 重启；前端 type-check + build + vitest；真 DB 跑迁移 + 验证；派 browser-tester 跑 7 表 e2e + 迁移回归 | T1~T5 |

- T4 与 T5 文件域不相交，可并行（均依赖 T3 完成）。
- T3 是阻塞点：API 契约 + composable 签名定型后 T4/T5 才能改调用方 → **T3 先单独完成并通过 type-check，再放行 T4/T5**。
- 提交策略：按子系统分层 commit（后端 / 迁移 / 前端底座 / 消费方），见 `feedback_layered_commits`。

## 4. 验证标准（Definition of Done）

1. 后端：单测绿 + build 绿 + 重启跑新接口（手测 `curl PUT/GET columns/aShares` 200、非法 tableId 400）。
2. 迁移：真 DB 跑通 + 验证 SQL 行数对齐 + 旧行保留 + 重跑幂等。
3. 前端：type-check + vite build + vitest 全绿；`SymbolsViewColumnPreferences` 全仓引用清零。
4. e2e：7 表逐个"改→存→重进→保留"全过 + 老用户迁移回归不丢 + 自选股/回测表跨浏览器跟随。
5. 提交：分层 commit；commit 前 `git branch --show-current` 确认分支（见 `feedback_check_branch_before_commit`）。
