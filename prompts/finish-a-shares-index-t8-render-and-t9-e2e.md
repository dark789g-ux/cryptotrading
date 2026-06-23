# 完成 A股指数 TAB：T8 K线 echarts 不渲染 ✅ + T9 剩余 e2e

## 目标
1. **T8**：DOM 层 ✅；**视觉层**（截图可见 K 线）❌ → 见 [`fix-a-shares-index-kline-modal-loading-overlay.md`](fix-a-shares-index-kline-modal-loading-overlay.md)
2. 补完 T9 剩余 e2e（列偏好持久化、旧 ths 路径回归、industry-amv 同步不 throw）。

## T8 根因与修复（2026-06-23）

**两层问题，此前只修了第一层：**

| 层 | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 mount | KlineChart vnode.el=null | n-tab-pane slot 顶层直接放自定义组件，LazyTeleport 上下文不 patch | **div.kline-pane-body 包裹** |
| 2 echarts | mount 正常但 chartInstance=null | 「空数据常驻 + 异步填充」时 watch 二次 renderChart 在 modal 上下文到不了 echarts.init | **镜像 FlowTrendModal：loading/empty/chart 三分支 v-if/v-else-if/v-else，bars 就绪后才 mount KlineChart** |

**误判澄清：** 原先认为 v-if 本身导致 mount 中断——实为 **缺 div 包裹** 时 v-if 才出问题。FlowTrendModal 一直用 div + v-else 挂载 KlineChart 且正常工作；ASharesIndexKlineModal 应完全对齐该结构，而非「始终渲染 KlineChart」。

**改动文件：**
- `apps/web/src/components/symbols/a-shares-index/ASharesIndexKlineModal.vue`
- `apps/web/src/components/symbols/a-shares-index/ASharesIndexKlineModal.spec.ts`（挂载时序回归）

## 现状

### T8 DOM 层 ✅ / 视觉层 ❌（2026-06-23）

DOM 指标（webbridge evaluate）已通过：`canvas=1`、`ecAttr` 有值、`klineMounted=true`、`barsLen=242`。

**截图复验未通过**：Modal 内仍见 loading spinner，`.modal-pane-overlay` 盖住已 init 的 chart。**勿仅凭 canvas 计数宣称 T8 完成。**

→ **接手修复视觉层**：[`prompts/fix-a-shares-index-kline-modal-loading-overlay.md`](fix-a-shares-index-kline-modal-loading-overlay.md)

### T8 技术方案摘要（勿回退）
1. `div.kline-pane-body` 包裹 + KlineChart 随 modal 首次 patch 常驻（overlay 遮 loading/empty — **overlay 本身待修，见姊妹交接**）
2. `KlineChart.renderChart`：rAF 50ms fallback + chartRef 重试 + renderGeneration（`KlineChart.vue:159-204`）
3. `ASharesIndexKlineModal`：`refreshChartAfterData` + 150ms 延迟（`:94-137`）

## 硬约束
- **KlineChart 是共享组件**：优先在 Modal 内修 overlay/load；改 `KlineChart.vue` 须跑 `KlineChart.spec.ts`。
- **AppModal 规范**（vue3-frontend.md）：Modal 复用 AppModal，子组件禁自带保存/取消按钮。
- **B 类服务端重查**：A 股指数 `open_time=YYYYMMDD`，禁 A 类客户端裁切（`sliceDateStringBarsByRange` 仅 YYYY-MM-DD）。
- **后端 dev 是 nest start 无 watch**：改后端必须重启；e2e 前确认后端跑最新代码。
- **重启用户环境先问**：kill/重启 dev/DB 前问用户。
- **webbridge 限制**：后台 tab `requestAnimationFrame` 节流（renderChart 的 `await raf` 挂）；截图经 Read 不渲染（不可肉眼验证）；eval 计数 DOM / 读 setupState 可靠。

## 验证标准
- **T8**：点行 → Modal → **截图可见** K 线+副图（非 spinner）；`canvas`>0；`loading=false` 时无 `.modal-pane-overlay`；日期区间 B 类重查。
- **T9 剩余**：列偏好持久化（勾选 aSharesIndex 列→刷新→不丢→**验完恢复默认**）；旧 `/api/ths-index-daily?ts_code=881101.TI` 不含大盘；industry-amv 同步不 throw。

## 前序进度
- T7 ✅（4eb99d3）；T8 第一层 mount 修复（去 v-if，**工作区未提交**）；migration 编码修复 ✅（cf631d4）。
- T9 已完成：migration 执行（533831+10576 行零丢失）、catalog name 乱码 UPDATE、接口层 e2e、大盘同步（8×1322）、门禁全绿。
- T9 剩余：列偏好 e2e、旧 ths 路径回归、industry-amv 同步验证。

## webbridge 真机调试踩坑（省下一会话）
- **找 Vue 活跃组件实例**：从父 `subTree` 递归 `findComp(vnode, name)`（`vnode.component.type.__name===name` → 返回 `vnode.component`），**别从 `.n-modal` teleport DOM 的 `__vueParentComponent` 链读**——后者是 HMR/teleport stale 残留，props/setupState 是旧值（本会话踩过，浪费 ~10 往返）。
- **evaluate 别长 await**：`await` >~2s 或 `await requestAnimationFrame` 在 webbridge 会 `Promise was collected` 或挂起；改**同步 evaluate + bash `sleep` 间隔**分步做。
- **navigate reload 后 evaluate 撞 reload 窗口挂**：navigate 复位（同 session 复用 tab）+ 短探活（`1+1` 或 `#app.__vue_app__`）恢复，再发正式命令。
- **evaluate code 含 CSS 选择器/引号**：Write 到 `.tmp/req.json` + `curl -d @/c/codes/cryptotrading/.tmp/req.json`（POSIX 路径），code 内用单引号，避 shell/JSON 多层转义碎。
- **多步浏览器流程**：写 `drive.sh`（navigate→sleep→各 tab click→poll rows→clickrow→sleep→count）后台跑（`run_in_background`），日志落 `.tmp/wb_drive*.log`，完成通知。
- **manual echarts.init 验证 el**：`await import('/node_modules/.vite/deps/echarts.js')` + `echarts.init(el)` + 简单 setOption，绕开 KlineChart 的 async renderChart，直接验 el 能否被 echarts init。
- **daemon running:false**：`~/.kimi-webbridge/bin/kimi-webbridge start`（幂等）；`extension_connected:false` 让用户开浏览器。

## 相关
- **T8 视觉层交接**：[`prompts/fix-a-shares-index-kline-modal-loading-overlay.md`](fix-a-shares-index-kline-modal-loading-overlay.md)
- spec：`docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md`
- 参照：`apps/web/src/components/money-flow/FlowTrendModal.vue`（AppModal+n-tabs+KlineChart，待实测其 echarts 是否真 init）
- KlineChart：`apps/web/src/components/kline/KlineChart.vue`（renderChart:159，watch:201）
- 技术坑 memory：`reference-n-modal-lazy-teleport-slot-klinechart`（**需更新**：echarts 不 init 非纯 raf 假象，前台也不渲染；manual init el 成功；去 v-if 已修 mount）
- 本会话原交接（T7-T9 全任务）：`prompts/archive/finish-a-shares-index-tab-t7-t9.md`
