# 完成 A股指数 TAB：T8 K线 Modal 渲染 + T9 剩余 e2e

## 目标
1. 定位/修复 T8 ASharesIndexKlineModal 点行后 KlineChart（MA/MACD/KDJ/成交量副图）在 dev 不渲染；或 production 验证其正常。
2. 补完 T9 剩余 e2e：列偏好持久化、money-flow 旧路径回归、industry-amv 同步不 throw。

## 现状摸底（file:line 为证，commit 在 `feat/a-shares-index-tab` 未推 origin）

| commit | 任务 | 状态 |
|---|---|---|
| `4eb99d3` | T7 行情表（types/api/columns/query/Panel） | ✅ e2e 1005 行通过 |
| `ecf692c` | T8 K线 Modal（n-tabs 包装镜像 FlowTrendModal） | ⚠️ 代码完成，dev 渲染待查 |
| `cf631d4` | migration .ps1 PowerShell 编码 bug | ✅ |

T1-T6 在 `a06e068` 之前已完成（catalog/同步/查询接口/列偏好/容器+stub/migration SQL）。

### T8 已验证通过
- build/type-check 绿（vite build + vue-tsc）
- 接口层：`GET /api/index-daily?ts_code=000001.SH` 返回 K线（`open_time`=YYYYMMDD、`volume`=股、MA/KDJ/MACD），`GET /api/indices/latest?type=market` 返回 8 大盘
- Modal 逻辑：程序化 `rowProps.onClick` 后 KlineModal.props.row=700468.TI、bars=242（loadKline 跑通）、KlineChart vnode 创建（v-if bars>0 正确选中）
- 数据层：index_daily_quotes 533831 行（行业/概念）+ 10576 行（8 大盘 × 1322，20210104-20260622）

### T8 未通过（dev）
- `.kline-chart-wrapper` / canvas / `[_echarts_instance_]` 全 0（KlineChart 不挂载 DOM）
- 曾试 ASharesIndexKlineBody 子组件方案（已删）：subTree=KlineChart vnode 但 **`vnode.el=null`**（vnode 创建了不 patch 到 DOM）

## T8 根因分析
AppModal（`n-modal preset=card`）的 default slot 在 LazyTeleport 上下文被调用（控制台 warn "Slot invoked outside of the render function"）。在该上下文实测：
- slot 顶层**自定义组件**（ASharesIndexKlineBody）→ `vnode.el=null`，不挂载 DOM
- slot 顶层**KlineChart 元素**（去 v-if 始终渲染）→ mount（`klineWrap=1`、chartSize 1032×468）但 echarts.init 不创建 canvas（renderChart 内 `await nextTick+raf` 后异常，手动调 renderChart 时 curl 挂起）
- slot 顶层 **naive-ui n-tabs**（当前方案，镜像 FlowTrendModal）→ dev 仍 `klineWrap=0`

FlowTrendModal（`apps/web/src/components/money-flow/FlowTrendModal.vue`，AppModal+n-tabs+KlineChart）工作是参照，但我的 n-tabs 方案 dev 仍不渲染。

**强怀疑**：dev HMR 累积（vite dev 跑 3+ 小时 + 本会话反复改 KlineModal 4 次重构），模块缓存损坏。硬刷新（navigate 整页）清页面状态但不清 dev server 模块缓存。production build（无 HMR）可能正常。

## T8 待办（优先级降序）
1. **重启 vite dev server**（kill :5173 + `pnpm dev`，先问用户）清 HMR 缓存，重测：navigate `/symbols` → A股数据 → A股指数 → 点行 → 看 K线 Modal 副图。若渲染，T8 完成（HMR 是元凶）。
2. **production 部署验证**：`pnpm prod:up` 或 build 后部署，真机点行验证。
3. 仍不渲染：对比 FlowTrendModal（money-flow 页打开行业趋势 Modal）实际 vnode/DOM 与我的 KlineModal，定位为何 n-tabs mount 而 KlineChart 不 mount。
4. 兜底：KlineChart 改用 Teleport+div overlay（不经 AppModal/n-modal），违反 AppModal 规范但避开 LazyTeleport。

## T9 剩余 e2e（T8 卡住时未测）
1. **列偏好持久化**：勾选 aSharesIndex 列 → 刷新 → 验 save→load 不丢（证明前后端 scope 同步）→ **验完恢复默认**（别留脚印）
2. **旧路径回归**：`/api/ths-index-daily?ts_code=881101.TI` 返回行业 K线且不含大盘（薄封装 WHERE category IN industry/concept）；money-flow 行业趋势 Modal + KDJ recalc 正常
3. **industry-amv 同步不 throw**：触发 industry-amv 同步（迁移第 7 步 assertSuffixes 已改 WHERE category，验证不因大盘行 throw）

## 硬约束
- **AppModal 规范**（vue3-frontend.md）：Modal 复用 AppModal，子组件禁自带保存/取消按钮
- **KlineChart 是共享组件**（UsIndexPanel/FlowTrendModal 在用），改动影响大，优先不动
- **B 类服务端重查**：A 股指数 open_time=YYYYMMDD，禁 A 类客户端裁切（sliceDateStringBarsByRange 仅 YYYY-MM-DD）
- **后端 dev 是 nest start 无 watch**：改后端必须重启；e2e 前确认后端跑最新代码（当前已跑 T1-T6 新代码，migration 已执行）
- **重启用户环境先问**：kill/重启 dev/DB 前问用户

## 验证标准
- T8：点 A股指数行情表行 → Modal 开 → KlineChart 渲染主图（K线+MA）+ 副图（VOL+KDJ+MACD）；canvas/`[_echarts_instance_]` 计数 > 0；工具栏日期选择器选区间 → 服务端重查
- T9 剩余：列偏好持久化 + 恢复默认；旧 ths 路径不含大盘；money-flow Modal 正常；industry-amv 不 throw

## 前序进度
- T7 ✅（4eb99d3）、T8 代码 ✅ dev 待查（ecf692c）、migration 编码修复 ✅（cf631d4）
- T9 已完成：migration 执行（533831+10576 行零丢失）、catalog name 乱码 UPDATE 修复、接口层 e2e、大盘同步（8×1322）、门禁（type-check/build/jest 91/lint 全绿）
- T9 剩余：列偏好 e2e、旧路径回归、industry-amv 同步验证

## 相关
- spec：`docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md`
- 参照：`apps/web/src/components/money-flow/FlowTrendModal.vue`（AppModal+n-tabs+KlineChart 工作范例）
- 本会话原交接（T7-T9 全任务）：`prompts/archive/finish-a-shares-index-tab-t7-t9.md`
