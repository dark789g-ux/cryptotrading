# 05 · 测试、门禁与 e2e

返回:[index.md](./index.md)

## 1. 门禁(合并前全绿)

| 检查 | 命令 |
|------|------|
| 前端类型检查 | `pnpm --filter @cryptotrading/web type-check` |
| 前端 SFC 编译(必须) | `pnpm --filter @cryptotrading/web build` |
| Vue 单文件 ≤500 行 | `pnpm --filter @cryptotrading/web lint:quant-lines` + 新文件人工自检 |
| 前端单测(若动到可测逻辑) | `pnpm --filter @cryptotrading/web test`(vitest) |
| 后端单测(回归) | 后端**不动**,但跑 portfolio-sim + signal-stats 现有 jest 确认零回归 |

> 重申 [.claude/rules/vue3-frontend.md](../../../../.claude/rules/vue3-frontend.md):
> `type-check`(vue-tsc) **不等于** SFC 编译;`defineProps`/`withDefaults` 宏错只有 `vite build` 或真机才暴露。
> 动到共享组件(SourceRow)与新组件,**合并前至少一次 `vite build`**,并真机点开组合模拟新建弹窗确认不白屏。

## 2. 真机 e2e 剧本(核心:全程不离开新建页)

前置:确认前端跑最新代码(vite HMR 自动);后端**未改**故无需重启(若误改了后端则按 CLAUDE.md 重启 server/worker)。

```text
剧本 ① 路径 A(选历史 run)
  打开组合模拟新建弹窗 → 来源方式=选已有方案 → 选一个有多 run 的方案
  → 历史 run 下拉列出全部 run(仅 completed 可选,默认最新)
  → 选一个【非最新】的历史 completed run → 填 label/仓位 → 保存
  → 运行组合 → 得 annualRet + 逐笔明细有数据(且对应所选 run,非最新)

剧本 ② 路径 B(内联定义新源,非阻塞)
  来源方式=新建信号源 → 开子弹窗 → 用 ConditionRows 定义一个全新入场条件
  + 选出场模式/参数 + universe + 区间 → 创建并运行
  → 子弹窗关闭,源行标「运行中 N%」(进度递增)
  → (此时尝试运行组合应被拦,提示源运行中)
  → 等 run completed → 源行标 ✓+统计 → 运行组合 → 消费该新 runId 跑通,出 annualRet+逐笔
  → 失败路径:构造一个会 failed 的 run(如必然 0 命中/非法标的条件触发 runner 异常→status='failed'+errorMessage)
            → 轮询侦测 status==='failed' → 源行标错+显 errorMessage(顺带验证 'failed' 枚举写对了,非 'error')
  → 嵌套弹窗:打开子弹窗时确认外层「新建组合」AppModal 不被关、子弹窗遮罩/ESC 行为符合预期

剧本 ③ 回归
  来源方式=选已有方案(取最新 run)→ 跑通(等价旧行为)
  来源方式=手填 uuid → 粘贴合法 runId → 跑通(等价旧行为)
```

## 3. 落源头核查清单(实现期亲验,勿采信二手)

遵循 [.claude/rules/data-integrity.md](../../../../.claude/rules/data-integrity.md):凡进硬逻辑的事实自查真码/真 DB。

- [x] `getRunProgress` / `listRuns` 路由参数 = **testId**(`signal-stats.controller.ts:109/118`)。
- [x] `triggerRun` 异步、立即返回 `{runId}`(`:100` + service 不 await runner)。
- [x] `SignalTestForm` 提交契约 = `defineExpose({submit})`,父组件须调 `formRef.submit()` 才触发校验+emit(`SignalTestForm.vue:415/481/484`)。
- [x] `validateSourceRuns` 拦 不存在/非completed/trades≤0(`portfolio-sim.service.ts:494-521`)。
- [x] **run.status 枚举 = `'running'|'completed'|'failed'`**(`signal-test-run.entity.ts:20` / `signal-stats.runner.ts:104` / `signalStats.ts:69`);进度字段 `status/phase/progressScanned/progressTotal/sampleCount/winRate`(`signalStats.ts:66-87`)。
- [x] `triggerRun` 同 test 已 running → 409 ConflictException(`signal-stats.service.ts:264-269`)。
- [x] `lint:quant-lines` 覆盖 `components/portfolio-sim` 与 `views/strategy`(`check-quant-vue-line-count.mjs:31-36`,MAX=500)。
- [x] 无编辑/克隆入口预填 runId(`PortfolioSimView.vue` 仅 fresh 创建);`CreateModal` 保存即 `emit('update:show',false)`(`:336-338`)。
- [x] `PortfolioSimSource` 含 `runId`(`portfolioSim.ts`),`testId` **不进模型**(RunPicker 局部持有,见 [02 §3](./02-frontend-components-and-types.md))。
- [ ] 实现期:run 进度字段在**前端 store/类型**与**后端响应**间序列化命名一致(driver 已核 entity/前端类型;落地时再核 service 出参 key)。

## 4. 验证标准(完成判定)

1. 三剧本(A/B/回归)真机全过,组合能出 annualRet 且逐笔有数据。
2. B 的运行中/完成/失败三态均验到;非阻塞下保存后由 `validateSourceRuns` 正确拦/放。
3. 全部门禁绿;新增/改动 `.vue` 均 < 500 行;`vite build` 通过且页面不白屏。
