# 04 · 错误处理、边界与待确认假设

返回:[index.md](./index.md)

## 1. 错误处理表

| 场景 | 处理 |
|------|------|
| B `create` 校验失败(后端 400) | 错误显在子弹窗内,弹窗**不关闭**,保留用户已填表单 |
| B `triggerRun` 失败(非 409) | 源行报错提示,`runId` **不回填**,来源方式停留可重试 |
| B `triggerRun` 撞 409(同 test 已有 running run) | 后端抛 ConflictException(`signal-stats.service.ts:264-269`)。提示「该信号源仍在运行,无需重复触发」,**不**当普通失败重试。B 每次新建独立 test 故首次不会撞,仅重复点按钮/再触发会撞 |
| B run 中途失败(runner 写 `status='failed'`+`errorMessage`) | 轮询侦测到 `status==='failed'` → 源行标错并展示 `errorMessage`,标记不可用,用户可重新定义/换源 |
| B run 仍 running 时保存组合 | **允许**(草稿);保存即关弹窗、源行销毁。保存后用户在列表页点「运行组合」时,组合 `triggerRun` 被 `validateSourceRuns` 拦,弹后端原始 400 toast(`PortfolioSimView.vue:71-74`)。「源运行中」实时提示**仅弹窗未关时**由源行展示(详见 [01 §3](./01-ux-and-flows.md)) |
| A 方案无 completed run | run 下拉为空,提示「无可用 completed run,请新建信号源或换方案」 |
| A `listRuns` 网络错误 | toast 报错 + 允许重试(重新选方案触发) |
| 手填 uuid 非法/不存在 | 行为同现状:前端不强校验格式之外,后端 `validateCreateDto` 拦非法 uuid、`validateSourceRuns` 拦不存在(回归不变) |
| 轮询泄漏 | completed/**failed**/组件 onUnmounted/关弹窗/切换来源方式 → 一律 `clearInterval` |

## 2. 轮询生命周期(防泄漏要点)

```text
启动:B triggerRun 成功 → startPolling(testId)
停止(任一即停):
  - status === 'completed'
  - status === 'failed'        ← 失败态枚举是 'failed' 不是 'error'(见 03 节已核实)
  - 用户把来源方式切走 / 删除该源行
  - 子弹窗/新建弹窗关闭(onUnmounted)
```

- 间隔 2s(与项目既有轮询节奏一致);单源行同一时刻最多一个 interval。
- 多个 B 源各自独立 interval,按 testId 隔离,互不覆盖。
- 参考 [.claude/rules/vue3-frontend.md](../../../../.claude/rules/vue3-frontend.md):`watch` 默认懒执行,
  依赖初始值的加载需 `{immediate:true}` 或 `onMounted` 补调;keep-alive 缓存下用 `onActivated`。

## 3. 回归项(老路不破)

1. **选方案(最新 run)**:默认来源方式,选中方案即取最新 completed run(等价现行为)。
2. **高级手填 uuid**:第三来源方式,`patch({runId: v.trim()})` 逻辑不变。
3. 既有组合模拟运行链路(loader/engine/anchorMode/熔断/动态仓位/composite 排序)零改动。

## 4. 已核实结案 + 残留假设

> 原「待确认假设」经 spec 自审 + 主 Agent 亲查真码后,绝大多数已结案
> (遵循 [.claude/rules/data-integrity.md](../../../../.claude/rules/data-integrity.md):子代理报告=二手,以下均已自查源头)。

**已核实结案(可直接采信)**:

- **A1 无编辑/克隆入口** ✅:`PortfolioSimView.vue` 仅 fresh 创建,无 clone/edit/prefill;`freshSource()` 默认 `runId=''`。
  → A 的二级 run 选择**不需要** `runId→testId` 反查,无需为编辑态设计。
- **A2 `SignalTestForm` 提交机制** ✅(已纠正):非纯 `@submit`,须父组件调 `defineExpose` 的 `submit()`
  (`SignalTestForm.vue:415/481/484`);实现见 [02 §1](./02-frontend-components-and-types.md)、[01 §3](./01-ux-and-flows.md)。
- **A3 run.status 枚举 + 进度字段** ✅:`'running'|'completed'|'failed'`(`entity:20`/`runner:104`/`signalStats:69`),
  进度字段 `status/phase/progressScanned/progressTotal/sampleCount/winRate`(`signalStats.ts:66-87`)全部已核。
- **A4 `lint:quant-lines` 覆盖** ✅:`check-quant-vue-line-count.mjs:31-36` ROOTS 含 `components/portfolio-sim` 与 `views/strategy`,
  MAX=500;新文件受 CI 强制。

**残留(真正需实现期亲查的边界)**:

- **R1 失败 run 的真机造法**:e2e 剧本② 需构造一个会 `failed` 的 run 验源行失败态——
  实现期定一个必然触发 runner 异常的条件(见 [05 §3](./05-testing-gates-and-e2e.md)),无设计风险。
