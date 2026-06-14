# 01 · 用户可见行为(UX 与流程)

返回:[index.md](./index.md)

## 1. 源行的三种来源方式

源行从现有「普通 / 高级」两模式扩成**三选一来源方式**(单选切换)。高级手填 uuid 原样保留(回归)。

```text
┌─ 信号源 #1 ─────────────────────────────────────────────┐
│ 来源方式:  (•) 选已有方案    ( ) 手填 uuid   ( ) 新建信号源 │
│                                                           │
│  方案:    [ kdj_j<0 全市场            ▼ ]                 │
│  历史 run:[ 2026-06-12 14:03 · 样本44万 · 胜52% · ✓  ▼ ] │  ← A 新增二级
│           (默认=最新 completed;仅 completed 可选)         │
│  ▸ 该源条件: 买入3条 / 出场 fixed_n N=5 / 全市场 / 区间…   │  ← 只读条件摘要
│                                                           │
│  label / 仓位比 / maxPos / exposureCap / 排序 / sizing …  │
└───────────────────────────────────────────────────────────┘
```

- **选已有方案**(默认):方案下拉 + 历史 run 二级下拉(路径 A) + 只读条件摘要。
- **手填 uuid**:单 `n-input` 手填 → `patch({ runId: v.trim() })`,逻辑与现 `PortfolioSimSourceRow.vue:48-56` 完全一致,仅迁入新组件。
- **新建信号源**:按钮开子弹窗(路径 B)。

> 来源方式是 **UI 局部状态**,不进 portfolio DTO(DTO 只认 runId),故不破契约。

**来源方式切换时的状态处置(避免脏 runId 泄漏进提交)**:每次切换来源方式,一律
`patch({ runId: '' })` 清空契约字段,并清掉 `testId / schemeId / 历史run 选中`、停掉轮询
(见 [04 §2](./04-errors-and-edge-cases.md)),让新方式从干净态开始。`canSubmit` 仅认 `runId` 非空,
故清空后该源回到「未填」态,用户须在新方式下重新选/填才能提交。

## 2. 路径 A — 选历史 run

选中方案后,二级下拉调 `signalStatsApi.listRuns(testId)`(返回 `SignalTestRun[]`,createdAt 倒序),
渲染每个 run:`createdAt · 样本数(sampleCount) · 胜率(winRate) · 状态`。

- **仅 `status==='completed'` 可选**;非 completed 项 `disabled` 并标状态(`running` / `failed`)。
- **非 completed 项的 `sampleCount/winRate` 为 null**(`signalStats.ts:81-82`,只有 completed 才填):
  这类项**只显 `createdAt + 状态`**,样本/胜率为 null 时省略或显 `-`;completed 项才显样本/胜率。
- **默认选中最新 completed run**(与现有「选方案取最新」语义一致 → 老路不破)。
- 选中后 `patch({ runId: 选中run.id })`,同时(由 RunPicker)记下 `testId`(供摘要/复用,见 [02 §3](./02-frontend-components-and-types.md))。
- 方案无任何 completed run → 下拉空,提示「无可用 completed run,请新建信号源或换方案」。

A **不轮询**(只允许已完成的 run)。

```text
选方案(testId) ─▶ listRuns(testId) ─▶ [run1✓, run2✗running, run3✓ …]
                                        └─默认选最新✓─▶ patch({runId: run.id})
```

## 3. 路径 B — 内联定义新信号源(非阻塞草稿 + 进度可见)

切到「新建信号源」→ 点「定义新信号源…」开子弹窗,**整体复用 `SignalTestForm`**
(入场 `ConditionRows` / 出场模式+参数 / universe / 日期区间)。

```text
┌── 新建信号源(组合模拟内联子弹窗) ─────────────────────┐
│  «整体复用 SignalTestForm»                              │
│  方案名 / 入场条件(ConditionRows) / 出场模式 + 参数 /    │
│  universe(all|list) / 日期区间                           │
│                              [取消]   [创建并运行]       │
└──────────────────────────────────────────────────────────┘
```

提交 [创建并运行] 的流程(注意 `SignalTestForm` 的**正向触发**契约):

```text
点子弹窗 #actions「创建并运行」按钮
   ▼  ⚠️ SignalTestForm 无内部提交按钮,须父组件调 formRef.submit() 才触发校验+emit
formRef.submit()  →  表单内部校验(buyConditions 非空/区间/exitConditions…)通过
   ▼
@submit(CreateSignalTestDto)  ← 回调里才拿到 dto
   ▼
create(dto) ─▶ {id=testId}      triggerRun(testId) ─▶ {runId}   (异步,立即返回)
   ▼
RunPicker 写入 runId + testId,关闭子弹窗,标「运行中」
   ▼
轮询 getRunProgress(testId) 每 2s  ──▶ status?  (枚举 running|completed|failed)
   ├─ running   → 显进度%(progressScanned/progressTotal),组合可先保存
   ├─ completed → 标 ✓ + 统计(样本/胜率),组合可正常运行
   └─ failed    → 标错 + errorMessage,可重新定义/换源
```

> `SignalTestForm` 经 `defineExpose({submit})`(`SignalTestForm.vue:484`)暴露提交方法,
> `@submit` 只在外部调用 `formRef.value?.submit()` 后才触发(现成对照:`SignalStatsView.vue:66-70/176`)。
> NewSourceModal 若只听 `@submit` 而按钮不调 `formRef.submit()`,点按钮将毫无反应、且绕过全部表单校验。
> 提交机制实现细节见 [02 §1](./02-frontend-components-and-types.md)。

**非阻塞要点**:组合方案可在源 run 未完成时**先保存**;真正运行组合时,现有
`validateSourceRuns`(组合 triggerRun 内)会拦「源 run 未 completed / trades=0」。**不需要新造阻塞式状态机**。
> ⚠️ 提示挂载位置(如实):「源运行中」实时提示**仅在新建弹窗开着、尚未保存时**由源行展示;
> CreateModal 保存成功即关闭弹窗(`PortfolioSimCreateModal.vue:336`)、源行随之销毁。**保存之后**用户在列表页点
> 「运行组合」时,`validateSourceRuns` 拒绝会以后端原始 400 文案弹 toast(`PortfolioSimView.vue:71-74`,
> 文案如「run 状态为 running,须为 completed」)。本设计**不**在列表页另造草稿提示(YAGNI)。

> `getRunProgress` 返回「当前/最近一次 run」,B 刚 triggerRun 的就是最新 run,故按 testId 轮询命中正确。
> 每个 B 各建独立 signal_test(testId 唯一),多个 B 源互不串扰。

## 4. 只读条件摘要(辅助选对源)

「选已有方案」与「新建信号源(完成后)」均在源行显示一行只读摘要,帮用户确认选对:

```text
▸ 该源条件: 买入3条 · 出场 fixed_n N=5 · 全市场 · 20230101~20260531 · 样本44万 · 胜52%
```

- **条件部分**(买入条件数 / 出场模式 / universe / 区间)来自 `signalStatsApi.findAll()`
  返回的方案字段(`buyConditions/exitMode/universe/dateStart/dateEnd`,弹窗打开时已在调)。
- **统计部分**(样本/胜率)来自该 run(A 来自 listRuns 选中项;B 来自 getRunProgress completed 后)。
- 纯展示,不可编辑;条件多时折叠/省略,可 popover 看全。

## 5. 三条路径汇总

```text
A 选历史run  ─┐
B 新建源      ─┼─▶ 源.runId(uuid) ─▶ loader/engine 原样消费 ─▶ annualRet/逐笔
手填 uuid     ─┘    (anchorMode 代数恒等等不变量不动)
```
