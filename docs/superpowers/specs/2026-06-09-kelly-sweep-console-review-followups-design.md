# Spec：kelly-sweep 操作台 review 后续优化（4 项打磨）

> 状态：已 brainstorming 定稿，待实现。
> 关联：主功能 spec `docs/superpowers/specs/2026-06-09-kelly-sweep-web-console-design/`（index+01~06）；记忆 `~/.claude/.../memory/project_kelly_sweep_web_console.md`；交接 `prompts/polish-kelly-sweep-console-review-followups.md`。

## 背景与目标

「凯利网格搜索 Web 操作台」最终 code review 列出 4 个**不阻断合并**的后续优化项，主功能已完整实现并合入本地 main、真机 e2e 全过。本 spec 把这 4 项收尾：

- **都不是 bug**（功能已真机验证正常），是质量/一致性/健壮性/可维护性打磨。
- 4 项**互相独立**，分属不同文件域，可分别实现、**分层提交**（每项一个 commit）。

行号均于 2026-06-09 经 Explore SubAgent 核实，交接文档 4 项描述全部准确（项 4 补充：ConfigForm 已 497 行，逼近 500 行 CI 上限）。

## 硬约束（必须遵守）

- Windows + PowerShell：命令禁 `&&`，用 `;` 或多行。
- 所有源文件 UTF-8；对象键名英文。
- 后端 `dev` 无 watch：改 `apps/server` 后**必须重启后端进程**才生效（前端 vite HMR 不受限）。
- 单 Vue 文件 ≤ 500 行（CI `lint:quant-lines`，约束 `views/quant/**` + `components/quant/**`）。
- TypeORM `.select()` 用实体属性名（`.claude/rules/database-sql.md`）。
- 改 Python（项 3）后 worker 无热加载，需重启 worker（`uv run quant worker run`）。
- **护栏**：项 3 不得碰 runner 末尾的 `update_progress(100)`——SSE 终态链依赖它，缺则前端卡 99。

## 不破坏现有（全程红线）

- CLI↔Web 交叉验证仍**零漂移**。
- 真机 SSE 进度仍 `…→100`、done 触发、结果自动加载（项 1/3 都可能影响这条链，务必真机复测）。

---

## 项 1（Important）：前端加载错误透出 —— UX

### 现状（file:line 已核实）

`apps/web/src/stores/kellySweep.ts`：仅 `summaryError`（:62）一个 error ref，`loadSummary`（:85-87）正常 set 并由 UI 展示。另三个加载 action 失败只 `console.warn`、不透 UI：
- `loadScatter` catch :102-104
- `loadTopk` catch :123-125
- `loadHistory` catch :146-148

`apps/web/src/components/quant/kelly-sweep/KellyGroupPanel.vue:84-86`：`fetchTopk`（翻页/排序触发）catch 也只 `console.warn`。

`apps/web/src/views/quant/kelly-sweep/KellySweepResultPanel.vue`（142 行，**注意在 `views/quant/` 下、受 lint:quant-lines 500 行约束**，当前 142 行加 props 后远不触线）以 props 驱动（详情弹窗 `showDetail`/`detailData`/`detailError` 为本地状态除外），散点/topK 区无错误状态展示；`KellyParetoScatter.vue` **已有 `:error` prop**，但 GroupPanel 现硬传 `:error="null"`（:6）。历史下拉在 `KellySweepView.vue:12-17` 的 `n-select`。

### 设计：分区内联展示，无重试按钮

复用 `summaryError` 红字风格 + `KellyParetoScatter` 现成 `:error` 插槽。

```text
store/kellySweep.ts
  + ref: scatterError / topkError / historyError  (仿 summaryError)
  loadScatter/loadTopk/loadHistory:
    action 开头 reset=null  →  catch 内 set=e.message（warn 保留作 debug）
        │                 │                  │
        ▼                 ▼                  ▼
   scatterError       topkError          historyError
        │                 │                  │
 ┌──────┴──────┐   ┌──────┴──────┐    ┌──────┴──────┐
 ResultPanel   │   ResultPanel   │    KellySweepView
 →GroupPanel   │   →GroupPanel   │    n-select 旁
 →ParetoScatter    topK 区上方        红字/n-alert
 :error 插槽        红字文案
 (替换硬传 null)    localError||props
```

### 改动清单

- `stores/kellySweep.ts`：
  - 新增 `scatterError`/`topkError`/`historyError`，均 `ref<string|null>(null)`，并 export。
  - `loadScatter`/`loadTopk`/`loadHistory`：action 开头将对应 error 清零；catch 内 `xxxError.value = e instanceof Error ? e.message : '<中文兜底文案>'`。`console.warn` 可保留作 debug。
- `views/quant/kelly-sweep/KellySweepResultPanel.vue`：新增 props `scatterError?: string|null`、`topkError?: string|null`（仿 `summaryError`），透传给 `KellyGroupPanel`。
- `KellyGroupPanel.vue`：
  - 接收 `scatter-error`/`topk-error` props。
  - 散点区：把 `scatterError` 接到 `KellyParetoScatter` 的 `:error`（替换 :6 硬传 `null`）。
  - topK 区：上方展示 `localError || props.topkError`。
  - 新增本地 `localError` ref：`fetchTopk` 失败时 set（替换 :85 `console.warn`），成功时清零。
- `KellySweepView.vue`：`n-select` 旁展示 `store.historyError`。

**散点 vs topK 不对称处理（有意为之）**：散点只接 store 级 `scatterError`、**不设** localError，因为散点**无翻页/排序的本地重取路径**（只有首次 `loadScatter`）；topK 有 `fetchTopk` 本地重取，故 `localError || props.topkError` 两路合并。实现者勿给散点补 localError。

### 验证

- `pnpm --filter @cryptotrading/web type-check` + `lint:quant-lines` + `test`(vitest) + `vite build` 全绿。
- 真机：停掉 server 故意造加载失败，散点/topK/历史三区均看到中文错误文案而非空白；恢复后重选 job/翻页错误自动清除。

---

## 项 2（Minor）：getHistory 查询风格统一（连带 getTopk）

### 现状（已核实）

`apps/server/src/modules/quant/kelly-sweep/kelly-sweep.service.ts`：
- `getHistory`（:324-329）：`.where("j.run_type = 'kelly_sweep'")` 字面量硬编码非参数化；`.orderBy('j.created_at','DESC')` 用 DB 列名。
- `getTopk`（:230-248）：where 用 DB 列名（`r.job_id`/`r.window_group`/`r.is_topk`），orderBy 用属性名（已经 KELLY_SORT_FIELD_MAP 映射）。
- `getScatter`（:209-224）：已用 `repo.find()` + 实体属性名，**风格正确**。

三者写法混用。**注意**：getHistory 现写法 TypeORM 能正常工作、真机 e2e 验证过，**非 bug**，纯风格一致性。

### 设计：统一为实体属性名 + 参数化

- `getHistory`：
  - `.where("j.run_type = 'kelly_sweep'")` → `.where('j.runType = :rt', { rt: 'kelly_sweep' })`
  - `.orderBy('j.created_at', 'DESC')` → `.orderBy('j.createdAt', 'DESC')`
- `getTopk`（连带统一，已定决策——同文件、低风险、一次到位）：
  - `.where('r.job_id = :jobId', { jobId })` → `.where('r.jobId = :jobId', { jobId })`
  - `.andWhere('r.window_group = :group', { group })` → `.andWhere('r.windowGroup = :group', { group })`
  - `.andWhere('r.is_topk = true')` → `.andWhere('r.isTopk = :isTopk', { isTopk: true })`
- `getScatter`：**不动**。

属性名↔列名映射已核实：`runType↔run_type`、`createdAt↔created_at`、`jobId↔job_id`、`windowGroup↔window_group`、`isTopk↔is_topk`。

### 验证

- `pnpm --filter @cryptotrading/server exec jest kelly-sweep` 绿。
- **重启后端**后真机 `/api/quant/kelly-sweep/history` 返回正确、按 createdAt DESC 排序对；topK 翻页/排序正确。

---

## 项 3（Minor）：persist 单事务原子化

### 现状（已核实）

`apps/quant-pipeline/src/quant_pipeline/research/kelly_sweep/persist.py`：DELETE 与批量 INSERT 分属两个独立 `session_scope`：
- DELETE 旧行：`with session_scope()`（:66-71）
- 批量 INSERT：`with session_scope()`（:131-134，`BATCH_SIZE=500` :130）

`session_scope`（`db/engine.py:35-47`）：`@contextmanager`，yield 后 commit、异常 rollback、finally close；**不支持嵌套**。

**后果**：DELETE 已 commit 但 INSERT 未完成时进程崩溃 → 旧行已删、新行未写的空窗。正常一次性运行影响为零，仅 job 重试时短暂不一致。

### 设计：合并为单个 session_scope

- 把 DELETE（:66-71）与批量 INSERT（:131-134）合并进**同一个** `with session_scope() as session:`：先 DELETE，再循环分批 INSERT，单次 commit 原子提交。
- **batch 列表构建放在事务外**（不需要 session），只把 DELETE + 批量 INSERT 收进事务，缩短事务持续时间。
- `BATCH_SIZE=500` 保留——仅控制 `session.execute` 分块，不再是事务边界。
- 事务大小：DELETE + 最多 6000+ 行 INSERT（max_entry_filters=2 时）单事务，PG 可接受。
- **不碰** runner 末尾的 `update_progress(100)`。

### 验证

- `uv run pytest tests/unit/test_kelly_sweep_runner.py`（含 persist 测试）绿。
- **重启 worker** 后重跑一次 kelly_sweep job：结果正常落库、SSE `…→100`、前端自动加载。

---

## 项 4（Minor）：ConfigForm 抽 composable + watch 守卫

### 现状（已核实）

`apps/web/src/views/quant/kelly-sweep/KellySweepConfigForm.vue`（**497 行，距 500 仅剩 3 行**）：
- `resyncLocalRefs`（:381-393）
- config deep watch（:395-401）→ 调 `resyncLocalRefs`
- `universeMode` watch（:293-302）→ 写 `config.value`
- `universeListText` watch（:304-311）→ 写 `config.value`

冗余往返：改 universe/日期 → config deep watch → resyncLocalRefs → 回写 universeMode/universeListText（值相同、无副作用，**不会无限循环**但有一轮多余 resync）。加守卫需 +4~6 行，必破 500 行 CI。

### 设计：抽 composable（同时腾出行数 + 守卫落位）

**已确认（无需实现期再查）**：
- `lint:quant-lines`（脚本 `apps/web/scripts/check-quant-vue-line-count.mjs`）**只扫 `.vue`**，`.ts` composable 不受 500 行约束。
- `config` 为 `defineModel<SweepParams>({ required: true })`（ConfigForm:243）；`defineModel` 是编译宏**必须留在 `.vue`**，把它返回的 model ref 作为入参传进 composable。
- composable 落点遵循项目约定 `apps/web/src/composables/<域>/`（已有 backtest/kline/hooks/api/symbols 子目录），新建 **`apps/web/src/composables/quant/useKellySweepConfigSync.ts`**。

**设计**：
- 入参 `config: Ref<SweepParams>`（即 defineModel 返回值）。
- **返回值须含模板实际绑定的全部符号**，否则搬完模板报未定义：
  - 4 个 ref：`universeMode`/`universeListText`/`trainRange`/`validRange`
  - 2 个 handler：`onTrainRangeChange`/`onValidRangeChange`（ConfigForm:341-351，写 `config.value`）
  - 内部私有（不必导出）：`resyncLocalRefs`、日期 helper `initDateRange`/`yyyymmddToTs`/`tsToYYYYMMDD`、3 个 watch（universeMode/universeListText/config deep）。
- **日期 helper 不得破坏 datetime.md 规则**：`yyyymmddToTs` 用 `new Date(y,m,d).getTime()` 取本地午夜、提取用 `getFullYear/getMonth/getDate`（日期选择器是本地 TZ 例外），照搬现有实现勿改。
- `resyncLocalRefs` 内加**「值真变化才写」守卫**：仅当新值 ≠ 当前值才赋值，消除冗余往返。
- `KellySweepConfigForm.vue` 改为 `const { universeMode, universeListText, trainRange, validRange, onTrainRangeChange, onValidRangeChange } = useKellySweepConfigSync(config)`，**减重 ~50 行 → ~440 行**，留健康余量。

### 验证

- `pnpm --filter @cryptotrading/web type-check` + `lint:quant-lines`（ConfigForm < 500）+ `test` + `vite build` 全绿。
- 真机：改 universe（all↔list 切换、输入清单）、改训练/验证日期，行为与之前一致、无异常往返；提交 job 配置正确透传。

---

## 提交策略（分层，每项一个 commit）

| 项 | 类型 | 范围 |
|----|------|------|
| 项 1 | `fix(kelly-sweep)` | 前端加载错误透出 |
| 项 2 | `refactor(kelly-sweep)` | getHistory/getTopk 查询风格统一 |
| 项 3 | `fix(kelly-sweep)` | persist 单事务原子化 |
| 项 4 | `refactor(kelly-sweep)` | ConfigForm 抽 useKellySweepConfigSync composable + watch 守卫 |

合入本地 main（未推 origin，沿用项目惯例）。

## 生命周期

完成后删除 `prompts/polish-kelly-sweep-console-review-followups.md`（或移入 `prompts/archive/`），别留主目录冒充待办。
