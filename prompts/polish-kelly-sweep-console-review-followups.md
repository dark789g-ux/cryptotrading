# 交接：kelly-sweep 操作台 review 后续优化（不阻断项）

> 本文自包含，可整段贴给全新会话/agent 直接接手，不依赖上一会话上下文。
> 这些是「凯利网格搜索 Web 操作台」最终 code review 列出的 **3 个不阻断优化项 + 1 个 Minor**，主功能已完整实现并合入 main、真机 e2e 全过，这些只是打磨。

## 一句话目标

把操作台 review 暴露的几处「能工作但不够好」收拾干净：前端加载错误别静默、后端查询风格统一、写库事务原子化。**都不是 bug**（已真机验证功能正常），是质量/一致性/健壮性打磨。

## 背景

凯利网格搜索 Web 操作台（复用 ml.jobs 异步+SSE、新增 `kelly_sweep` run_type、结果落 `research.kelly_sweep_results`）已 2026-06-09 完整实现并合入本地 main（7 commit：spec+B1~B5+uv.lock）。各批次独立审查 + 最终整体 review ✅ 可合并；CLI↔Web 交叉验证零漂移 + 真机浏览器 e2e 全过。spec：`docs/superpowers/specs/2026-06-09-kelly-sweep-web-console-design/`（index+01~06）。记忆：`~/.claude/.../memory/project_kelly_sweep_web_console.md`。

下面 4 项是 review 明确标「不阻断合并」的后续优化，按价值排序。**接手前请先各自 grep 核实行号**（下方行号 2026-06-09 核实，可能因后续改动微移）。

## 现状摸底（file:line 为证，2026-06-09 核实）

### 项 1（Important）前端加载错误静默吞错 —— UX

`apps/web/src/stores/kellySweep.ts`：只有 `summaryError` 一个错误 ref（:62），加载失败时 `summaryError.value = ...`（:86）正常透出。但另外三个加载 action 失败只 `console.warn`、**不向 UI 透出**：
- `loadScatter` catch → `console.warn`（:102-103）
- `loadTopk` catch → `console.warn`（:123-124）
- `loadHistory` catch → `console.warn`（:146-147）

`apps/web/src/components/quant/kelly-sweep/KellyGroupPanel.vue:84-85`：`fetchTopk`（翻页/排序触发）catch 也只 `console.warn`，仅 `localLoading=false`，无错误状态。

**后果**：散点 / top-K / 历史下拉加载失败时用户看到空白、无提示（summary 失败有提示，但 scatter/topk 单独失败无反馈）。违反项目「禁止静默吞错」精神（虽该红线主要约束后端 sync 任务，但 UX 上调试困难）。

**方向**：给 store 加 `scatterError`/`topkError`/`historyError` ref（仿 `summaryError`），catch 时 set；在 `KellySweepResultPanel.vue` 散点/topK 区、`KellyGroupPanel.vue`、历史下拉处用 `n-alert` 或文案展示错误。
**开放问题**：错误展示粒度（每区独立 alert vs 顶部统一）；是否给「重试」按钮。注意 Vue ≤500 行（ResultPanel 现 144 行 / GroupPanel 107 行，有空间）。

### 项 2（Minor）getHistory QueryBuilder 列名/风格不一 —— 一致性

`apps/server/src/modules/quant/kelly-sweep/kelly-sweep.service.ts` 的 `getHistory`（:317 起）：
- `.where("j.run_type = 'kelly_sweep'")`（:326）—— **字符串硬编码值**，非参数化。
- `.orderBy('j.created_at', 'DESC')`（:327）—— 用 **DB 列名** `created_at`，而实体属性名是 `createdAt`。

对比同文件 `getScatter`/`getTopk`（:243-246, :291-293）：`where`/`andWhere` 用 DB 列名但**参数化**（`:jobId`/`:group`），`orderBy` 用 `r.${field}`（field 来自 sort 白名单映射的**属性名**）。

**注意**：getHistory 这写法 **TypeORM QueryBuilder 里能正常工作**（where/orderBy 字符串作 SQL 片段直传，DB 列名正确），**真机 e2e 验证过 history 接口 OK**。这纯属风格一致性，**非 bug**。
**方向**：统一为实体属性名 + 参数化：`.where('j.runType = :rt', { rt: 'kelly_sweep' })` + `.orderBy('j.createdAt', 'DESC')`。改后跑 jest + 真机 history 接口确认仍返回正确数据（database-sql rule：`.select()` 必须属性名；where/orderBy 字符串虽容忍 DB 列名，但项目倾向属性名/参数化）。
**开放问题**：纯风格改动是否值得；要不要顺带把 getScatter/getTopk 的 `r.job_id`/`r.window_group`/`r.is_topk`（已参数化，风险低）也统一成属性名。

### 项 3（Minor）persist_results 双事务 —— 健壮性

`apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/persist.py`：DELETE 与批量 INSERT 分属**两个独立 `session_scope`**：
- DELETE 旧行：`with session_scope()`（:66-68）
- 批量 INSERT：`with session_scope()`（:131-133，BATCH_SIZE=500）

**后果**：若 DELETE 提交后、INSERT 完成前进程崩溃，出现「旧行已删、新行未写」空窗。**正常一次性运行影响为零**；仅 job 重试（`max_attempts`）时有短暂不一致。job 失败会标 `failed`、前端不查 failed 结果，故现状是「可接受的最终一致性」。
**方向**：合并为单 `session_scope`（先 DELETE 再批量 INSERT 同事务），保证原子性。注意单事务内大批量 INSERT（848 行，max_entry_filters=2 时可达 6000+）+ DELETE 的事务大小（PG 可接受）。
**开放问题**：是否真需要（重试罕见）；单事务 vs 现状的取舍。

### 项 4（附，Minor）ConfigForm deep-watch 轻微冗余 —— 可选

`apps/web/src/views/quant/kelly-sweep/KellySweepConfigForm.vue:395-401`：`watch(() => config.value, resyncLocalRefs, {deep:true})` 与 `universeMode`/`universeListText` 各自的 watch 相互触发——**不会无限循环**（resyncLocalRefs 写相同原始值时 Vue 不再 notify），但用户每次改 universe/日期有一轮额外 resync（值相同、无副作用）。
**方向**：resyncLocalRefs 内加「值真变化才写」守卫。**最低优先，可不做**。

## 硬约束 / 项目规范（必须遵守）

- Windows + PowerShell（禁 `&&`，用 `;`）；所有源文件 UTF-8；对象键名英文。
- 后端 `dev` 无 watch：改 `apps/server` 后**必须重启**后端进程才生效（前端 vite HMR 不受限）。
- 单 Vue 文件 ≤500 行（CI `lint:quant-lines`，约束 `views/quant/**` + `components/quant/**`）。
- TypeORM `.select()` 用实体属性名（见 `.claude/rules/database-sql.md`）。
- 改 Python（项 3）后 worker 无热加载需重启 worker（`uv run quant worker run`）。

## 验证标准

- **不破坏现有**：CLI↔Web 交叉验证仍零漂移；真机 SSE 进度仍 `…→100`、done 触发、结果自动加载（项 1/3 都可能影响这条链，务必真机复测）。
- 项 1：前端 `type-check` + `lint:quant-lines` + `vitest` + `vite build` 全绿；真机故意造加载失败（如停 server）看到错误提示而非空白。
- 项 2：`pnpm --filter @cryptotrading/server exec jest kelly-sweep` 绿；真机 `/api/quant/kelly-sweep/history` 返回正确、排序对。
- 项 3：`uv run pytest tests/unit/test_kelly_sweep_runner.py`（含 persist 测试）绿；重跑一次 kelly_sweep job 确认结果正常落库。

## 前序进度 / 上下文指针

- 主功能 7 commit 已合入本地 main（未推 origin，沿用项目惯例）；最近 commit `516152e`(uv.lock)/`1d1559b`(B5 fix)。
- 这 4 项**互相独立**，可分别做、分别提交（用户偏好分层 commit）。建议各项一个 `fix(kelly-sweep):` 或 `refactor(kelly-sweep):` commit。
- 关键背景（来自真机 e2e）：worker runner 完成必须 emit `progress=100` 否则 SSE 终态链断（见记忆 `project_kelly_sweep_web_console.md`）——项 3 改 persist 时别动到 runner 末尾的 `update_progress(100)`。
- **生命周期**：本文件做完后删除或移入 `prompts/archive/`，别留主目录冒充待办。
