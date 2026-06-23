# Browser Driving — 累积经验

每条都是真实驱动浏览器时撞到的具体障碍 + 萃取出来的结论。**开始浏览器工作前扫一遍；结束后追加**（按 SKILL.md 里的复盘协议）。

最新条目置顶。

---

## 2026-06-23: ASharesIndexKlineModal 真机 e2e — v-else 仍 klineMounted=false；常驻+延迟 refreshChartAfterData
**Symptom**: div 包裹 + v-else 数据就绪后挂载：bars=242、klineMounted=false（LazyTeleport 重渲染创建组件仍中断）。改常驻 KlineChart 后 mount 正常但 canvas=0；手动 `await klineRef.renderChart()` / `echarts.init(el)` 均成功。
**Cause**: (1) v-if/v-else 等数据后再创建 KlineChart 在 LazyTeleport 内 mount 中断；(2) 空数据常驻时内部 watch 二次 renderChart 不可靠；(3) API 返回时 klineRef/布局未就绪，同步 refreshChartAfterData 空跑；(4) KlineChart renderChart 纯 rAF 在后台 tab 可能永不 resolve。
**Lesson**: n-modal 内：**div 包裹 + KlineChart 首次 patch 常驻** + `loadKline` 后 **refreshChartAfterData + ~150ms 延迟补调**；共享 KlineChart 加 rAF fallback 与 chartRef 重试。webbridge 验 canvas/ecAttr，别 await renderChart 做自动化（会挂）。

---

## 2026-06-23: ASharesIndexKlineModal echarts 不 init — 对齐 FlowTrendModal「div 包裹 + 数据就绪后 v-else 挂载」
**Symptom**: 去 v-if 后 KlineChart mount 正常（isMounted=true、chartRef 有 DIV），但 echarts 仍不 init（canvas:0）；manual echarts.init(el) 成功。
**Cause**: 两层独立问题：(1) n-tab-pane slot 顶层直接放 KlineChart → LazyTeleport 上下文 vnode.el=null，需 **div 包裹**；(2) 「空数据常驻 KlineChart + 异步填充 bars」时 watch 二次 renderChart 在 modal 上下文到不了 echarts.init——FlowTrendModal 的正确模式是 **loading/empty/chart 三分支，bars 就绪后才 v-else 挂载 KlineChart**（首次 mount 即带全量 data，watch immediate 一次 init）。
**Lesson**: n-modal 内 KlineChart 必须 **div 包裹 + 数据就绪后挂载**（镜像 FlowTrendModal trend-modal-body），勿「始终渲染等数据填充」。原先误判 v-if 本身有问题——实为缺 div 时 v-if 才 mount 中断。

---

## 2026-06-23: 找子组件真实实例从父 subTree findComp，别从 teleport 目标 DOM 链
**Symptom**: 读 KlineModal.props.row 从 `.n-modal` 的 `__vueParentComponent` 链始终 null，但父 Panel `selectedRow=700468.TI` 明明有值，反复误判 props 传递断裂（浪费 ~10 个往返）。
**Cause**: `.n-modal`（teleport to body）DOM 链上的 KlineModal 实例是 HMR/teleport **stale 残留**，非 Panel 当前渲染的活跃实例；其 props/setupState 是旧值。
**Lesson**: 找子组件真实活跃实例，从**父组件 `subTree` 递归 findComp**（`vnode.type.__name===name` 返回 `vnode.component`；遍历 `vnode.component.subTree` 和 `vnode.children`），别从 teleport 目标 DOM 上溯——后者常是 stale 实例，props/setupState 是旧值，误导调试方向。

---

## 2026-06-23: KlineChart.renderChart（defineExpose）手动调经 webbridge evaluate 会挂起
**Symptom**: evaluate 内 `await inst.setupState.renderChart()` 的 curl 无输出（-m 25 超时不返回），疑似 echarts.init 在 LazyTeleport el 上挂起。
**Cause**: renderChart 内 `await nextTick + requestAnimationFrame + echarts.init(el) + setOption`，在 Modal/LazyTeleport 上下文经 webbridge 调用挂起（具体成因未定位）。
**Lesson**: 别用 webbridge evaluate 手动调 KlineChart.renderChart 验证渲染。改读 DOM 计数（`.kline-chart-wrapper`/`canvas`/`[_echarts_instance_]`），或动态 import buildKlineChartOption 纯函数（见 2026-06-20 条）喂真实数据断言 option。

---

## 2026-06-20: 验证"真实生产代码的输出"——Vite dev 下动态 import 源码模块直接调
**Symptom**: 要验证 KlineChart 的 `buildKlineChartOption` 在真实数据下产出正确的 VOL 染色。两条路都不通：① 重写逻辑算一遍有"重写逻辑=业务逻辑→假通过"漏洞；② 从 DOM/echarts 实例读渲染态被 v5 WeakMap 堵死（见上条）。像素采样又被同色系元素（MA60/KDJ.K 都用 `#0ECB81` 绿）污染，无法干净定位 VOL 副图。
**Cause**: 模块作用域的纯函数既不在 window，DOM 上也没有调用入口；但 Vite dev server 让浏览器能通过 HTTP 按源码路径动态 import 模块。
**Lesson**: **`await import('/src/path/to/module.ts')` 动态导入真实模块**，喂真实 fetch 数据，直接调导出函数（如 `mod.buildKlineChartOption({data, echartsTheme:{}})`）读它返回的 option——这是"真实生产代码 + 真实数据"的端到端验证，比重写逻辑或读像素都精确（直接拿到 `rgba(...,0.35)` 字符串，可正则断言 alpha）。路径用 Vite 根的 `/src/...`。配合上条"echarts 实例读不到"，这是验证 echarts option 的最佳兜底。注意：截图经 Read 工具只"上传 CDN"不渲染给模型，依赖肉眼的截图验证在本环境不可行——优先用动态 import 这类可程序断言的方法。

---

## 2026-06-20: ECharts v5 实例无法从 DOM 读取——验证渲染态改走"数据层 + 组件实例 / fetch 后端"
**Symptom**: 想读页面里 echarts 图表的 `getOption()` 验证某 series 的 itemStyle.color 是否正确。`el.getAttribute('_echarts_instance_')` 有值（实例 id），但 `Object.getOwnPropertyNames(el)`、`Object.getOwnPropertySymbols(el)`、`el.__echarts__` / `el.__ec` 全空——实例不挂在 DOM 上。`window.echarts` 也不存在（业务代码用 ES module `import * as echarts`，不挂全局），调不了 `echarts.getInstanceByDom(el)`。
**Cause**: ECharts v5 把实例存在内部 WeakMap（`instances` Map，key 是 DOM），只通过同模块的 `getInstanceByDom` 暴露；DOM 元素上不留任何可枚举/不可枚举引用。模块未挂 window 时外部拿不到这个入口。
**Lesson**: 别试图从 DOM 直接取 echarts 实例读渲染态。两条务实替代：① **fetch 后端 API 拿原始数据 + 内联 spec 规则重算**（独立第三份实现，断言结构性事实如"背离柱存在/首根实色/分类计数"，而非"颜色值对不对"——避免重算逻辑=业务逻辑导致假通过）；② 从 Vue 组件实例（KlineChart `defineExpose` 暴露了 `prefs/renderChart`）或上溯 `setupState` 拿喂给 echarts 的真实 data。验证"图渲染了"只需数 `canvas` / `[_echarts_instance_]` 元素计数（见 2026-06-09 条）。

## 2026-06-20: webbridge screenshot 传任意 path 不可信——只有不传 path（走默认 temp）才稳
**Symptom**: `screenshot` 传 `"path":"/c/codes/cryptotrading/.tmp/x.png"`，daemon 返回 `{"ok":true,"path":"/c/codes/...","sizeBytes":437192}` 像成功，但 `ls /c/codes/.../.tmp/*.png` 和 `C:\codes\...\.tmp\*.png` 都找不到文件。改传 `"/c/tmp/x.png"`（= `C:\tmp\`，历史截图都在这）同样不落盘。
**Cause**: daemon 对 caller 指定的 POSIX 路径处理与文档/历史不符——它声称写到了 path，实际文件不存在于任何候选位置。只有**不传 path**（让 daemon 自己选 OS temp）时，返回的 path 才真实可信（形如 `C:\Users\<u>\AppData\Local\Temp\kimi-webbridge-screenshots\screenshot_<ts>.png`）。
**Lesson**: 截图一律**不传 path**，用返回的 `.data.path`（绝对 Windows 路径）直接喂 Read 工具。对 2026-05-27"Windows 截图用 POSIX 路径"那条的修正补充：caller 自定义 POSIX path 不可信，默认 path 才可靠。需可控文件名时，事后 `cp` 到目标位置。

---

## 2026-06-19: Windows 上 Write 工具的 `/tmp/` 与 git-bash `/tmp` 不是同一个目录
**Symptom**: 用 Write 写 `/tmp/eval.json`，随后 `curl -d @/tmp/eval.json` 调 webbridge 报 `invalid JSON: EOF`；`cat /tmp/eval.json` 也报 `No such file`。
**Cause**: Write 工具把绝对路径 `/tmp/...` 映射到 Windows 根目录 `C:\tmp`；git-bash 的 `/tmp` 却指向用户级 Temp（`%TEMP%`），二者不重叠。
**Lesson**: 浏览器 e2e 的临时请求 JSON 统一落到**项目目录内的 `.tmp/`**（如 `/c/codes/cryptotrading/.tmp/`），`curl -d @/c/.../.tmp/xxx.json` 与 Write 路径一致，避免跨工具路径漂移。

## 2026-06-19: 别用 CSS `:last-child` 点语义上的“最后一个按钮”
**Symptom**: 想点 SymbolsPanelLayout 的视图切换按钮，用 `.panel-header button:last-child` 实际触发了 Refresh。
**Cause**: 按钮被包在多个 flex wrapper / slot 里，`:last-child` 匹配的是某个 wrapper 的最后一个子元素，不一定是整组按钮里的目标。
**Lesson**: 驱动一组按钮时，用 `document.querySelectorAll('.panel-header button')[index]` 并按已知文本/空文本/Aria 区分；避免依赖 `:last-child` 或 `:nth-child` 做语义定位。

## 2026-06-19: Vue `__vueParentComponent.setupState` 里的 ref 已被自动 unwrap，别再手动 `.value`
**Symptom**: 想读 CryptoSymbolsPanel 的 `symbols` ref，用 `inst.setupState.symbols.value.length` 报 `Cannot read properties of undefined (reading 'length')`；改成 `inst.setupState.symbols.length` 立刻正常。
**Cause**: Vue 组件实例的 `setupState` 是一个 Proxy，访问其属性时会自动解包 ref（dev 模式 behavior），所以 `setupState.foo` 直接拿到 ref 的值，而不是 Ref 对象本身。
**Lesson**: 通过 `__vueParentComponent.setupState` 驱动 Vue 组件状态时，**不要加 `.value`**；只有拿到真正的 Ref 对象（如 `setupState.props` 不是 ref）时才需要。如果不确定，先用 `typeof` 探一下。

## 2026-06-19: evaluate 含 CSS 属性选择器/引号时，用文件传 code 而非 inline JSON
**Symptom**: `evaluate` 传 `document.querySelector('[role=dialog]')` 或读取 `.innerText` 时，daemon 偶发报 `ReferenceError: dialog is not defined` / `SyntaxError: Unexpected token '.'`；同一段 code 写进文件再 `curl -d @file` 就正常。
**Cause**: curl inline `-d '{...}'` 里，code 字符串的引号/方括号要穿过多层解析（shell、JSON、daemon），`[role=dialog]` 这类选择器在传输中被剥掉单引号，到浏览器里变成对未定义变量 `dialog` 的引用；带点号的属性访问也易被误切。
**Lesson**: 凡 `evaluate` code 含 CSS 属性选择器、字符串字面量、或任何需要引号/方括号的内容，一律 **Write 到临时 JSON 文件 + `curl -d @/c/.../req.json`**，code 内部用单引号（已在 2026-06-05 验证可行）。这是 2026-06-05「写文件避转义」的延伸：不仅复杂 code，任何带选择器的短代码也建议文件传，避免 shell JSON 层碎掉。

## 2026-06-18: 测父组件 @event 接线——在子组件实例上 emit，别去驱动那个脆弱控件
**Symptom**: 要验「日期选择器 update:range → 父组件按新区间发请求」。直接驱动 n-date-picker（开日历翻月点格）脆；父组件的 handler（如 onOamvRangeChange）在 `<script setup>` 里、没 defineExpose、setupState 也未必拿得到，难直接调。
**Cause**: `<script setup>` 顶层函数不一定挂到可调用的 exposed/setupState；而触发链其实是「子组件 emit('update:range') → 父模板 @update:range 绑定的 handler」。
**Lesson**: 找到子组件的根 DOM（如 KlineChart 的 `.kline-chart-wrapper`）→ `el.__vueParentComponent`（即该子组件实例）→ `inst.emit('update:range', payload)`，直接触发父组件的 `@update:range` handler，绕开脆弱控件。payload 用本地午夜 ms（`new Date(y,m,d).getTime()`）。先 `network start --filter <api>` 再 emit，用 `network list` 抓出站请求 URL（GET 的 query 参数就在 URL 里，比 requestBody 稳）验证端到端。补「设 exposed ref / Pinia action 直取」之外的第三条：**emit 子组件事件测父接线**。

## 2026-06-18: 直 fetch 验证要实体 ID 时，用已知规范值，别从 data-table DOM 里抠
**Symptom**: 想 `evaluate` 内直 fetch `/api/klines/<symbol>/...` 验后端，去 `.n-data-table-tr`/`.n-data-table-td` 抠首行 symbol——第一次抠到的是价格列（`0.521000`）不是 symbol，第二次同一选择器 cell 又空（虚拟滚动/重渲），连撞 2-3 个往返。
**Cause**: data-table 列顺序不定、虚拟滚动、tab 切换后重渲，DOM 抠实体值既不稳又易抠错列。
**Lesson**: 直 fetch 验证只是要个能打通接口的实体 ID 时，**直接用已知规范值**（crypto 用 `BTCUSDT`、A 股用 `000001.SZ`、美股用 `AVGO`），或打 list 接口（`/api/.../symbols`）取，别从 data-table DOM 抠。多备几个候选循环试（BTCUSDT→ETHUSDT→…取第一个有数据的），一发命中。延续 [虚拟滚动藏选项] / [@e ref 跨快照重编号]：data-table DOM 只配合 @e 点击，别拿来当数据源。

## 2026-06-16: webbridge navigate 是整页重载——清空 SPA 的 Pinia/内存态，测「SPA 内切页 store 存活」要用 router.push
**Symptom**: 验「切走某视图再切回进度是否保留」，用 webbridge `navigate` 切到别的路由再 navigate 回来，读 Pinia store 仍有数据——但这没真正测到"组件销毁后 store 内存存活"，因为 navigate 每次整页重载、JS 状态(含 Pinia)被清空，数据是靠页面 onMounted 的后端拉取(fetchActive)重新拉回来的。
**Cause**: webbridge `navigate` 走浏览器级整页导航(document 重载、app 重新 boot)，不是 SPA 路由内跳转；Pinia/内存 ref 全部重置。
**Lesson**: 两条恢复路径分开测：① 真·SPA 内切页(store 内存存活)——`evaluate` 里 `router.push('/other')` 再 `router.push('/back')`，**不重载**，验 store 单例跨路由存活；② 刷新/换设备恢复(store 清空靠后端还原)——用 `navigate`(整页重载)再读 store，验 onMounted 的 fetch 把状态拉回。navigate 测到的是更强的 ②(通常蕴含 ① 也成立)，但要测 bug 复现的精确机制时别把两者混为一谈。

## 2026-06-14: 驱动后端异步 job——状态轮询直接打 DB，别经 webbridge evaluate
**Symptom**: 经 webbridge evaluate 轮询 portfolio-sim run 进度，后台 poll 循环首轮 curl 迟迟不返回（卡在 iter 1）；但 run 本身已在数秒内 success（DB 直查得到）。随后 trigger evaluate 也卡，而 daemon `status` 却健康（running+connected）。
**Cause**: 先前一条悬空的 evaluate 堵了该 session 的页面命令队列（同 2026-06-10 根因——页面命令排在悬空命令之后）；且后端 job 极快（loader 数秒跑完），等 webbridge 反而比直查 DB 慢。
**Lesson**: 凡 job 状态有后端可直查的落点（本项目 `docker exec crypto-postgres psql ... SELECT status,phase,annual_ret FROM <run表>`），**轮询一律直接打 DB**——更快、绕开 webbridge session 卡死、不占浏览器 tab。webbridge 只留给「必须登录态」的写操作（create/trigger，fetch 带 cookie）。webbridge 写也卡时：换**新 session** `navigate {newTab:true}` 重建（2026-06-10），登录态是浏览器级持久、新 tab 仍登录。别在 fast backend job 上用 webbridge 轮询循环。

## 2026-06-14: 验「标签渲染为中文/没落 fallback」——别扫整页找原始枚举 token，name/id 列含字面量是假阳性
**Symptom**: e2e 验出场模式标签是否中文，扫 `main.innerText` 找原始 token `phase_lock`/`trailing_lock`，命中数 >0，疑似 fallback bug。
**Cause**: 命中全在 name 列——方案/运行名字本身含这些字面量（如 `trailing_lock_e2e_full`、自造的测试方案名「E2E phase_lock…」），不是标签 fallback。
**Lesson**: 验 fallback 别扫整页原始 token。① 用 TreeWalker 定位每个命中的 `closest('td').getAttribute('data-col-key')`，排除 name/id 列；或 ② **正面断言**目标列 distinct 文本全是中文（读 `col-key=exitMode` 单元格去重，看到 `两阶段锁定止损`/`固定N日(N=x)` 才算过）。附：`querySelectorAll('*')` 遍历时 SVG 等节点 `el.innerText` 是 undefined，比较前一律 `(el.innerText||'')` 否则 `.trim()` 抛错。preview_* (Claude_Preview MCP) 经 MCP JSON 传输，eval 里中文字面量不被破坏（无 PowerShell→webbridge 的 GBK 问题），可放心在 eval 内匹配中文。

## 2026-06-11: 多小时无人值守批量触发——session tab 被用户浏览占用两次卡死批次，终解=专用 newTab+触发前 navigate 复位+curl 超时+DB 防重 adopt
**Symptom**: 后台 bash 循环经 webbridge evaluate 串行触发 18 个长任务，跑到第 3/15 个时 TRIGGER 调用永不返回（批次静默挂 6 小时）；恢复后又在第 11 个复现（响应空+extension_error "Inspected target navigated or closed"）。
**Cause**: 自动化 session 绑定的 tab 是用户浏览器里可见的普通 tab，用户拿它看页面/导航，恰逢 evaluate 在途→页面销毁回调丢失（同 2026-06-10 条根因），但**长批次把碰撞概率放大到必然**。
**Lesson**: 无人值守批量驱动一律：① `navigate {newTab:true, group_title:"xxx-AUTO-勿动"}` 开专用 tab 并明示用户勿动；② 每次触发前先 navigate 复位页面上下文（1-2s 成本买回调可靠性）；③ 触发 curl 必带 `-m 60`；④ 响应丢失≠未执行——fetch 可能已落服务端（本例 POST 已建任务），恢复前先查 DB 按"最近 N 分钟新行"adopt，防重复触发；⑤ 循环对已有 running/completed 任务一律 adopt 跳过触发，脚本可安全重启续跑。

## 2026-06-10: 重启 webbridge daemon 后 session→tab 绑定丢失，find_tab 也救不回——直接 navigate newTab
**Symptom**: daemon 残留 PID 卡死，按既有经验 `stop + rm ~/.kimi-webbridge/daemon.pid + start` 恢复了(running:true、extension 秒重连)；但下一条 `evaluate`(session:"bz-opt") 报 `session "bz-opt" has no tab — navigate or find_tab first`；改用 `find_tab` 又报 `no open tab found matching <url>`。
**Cause**: daemon 重启会清空 session 与浏览器 tab 的映射；且重启过程往往把原 tab 也关了(或映射彻底失联)，所以 find_tab 按 URL 也匹配不到那个"旧 tab"。
**Lesson**: daemon 重启/恢复后**别指望 session 还认得旧 tab**，find_tab 也别浪费往返——直接 `navigate {newTab:true}` 重开一个新 tab 重建 session。登录态(cookie)是浏览器级、跨 tab 持久的，新 tab 仍是登录态(fetch /api/auth/me 验一下即可)。配合 [2026-05-27 残留 PID] 那条用：恢复 daemon → navigate newTab → 验 auth → 继续。

## 2026-06-09: 浏览器验证「前端发起的异步后台任务状态机」——Pinia 直取 action + 后台时间线采集
**Symptom**: 要验证"进度条满了任务却没结束、完成后是否自动切"这类状态机,需在浏览器发起一个长任务(run)并采集 status/progress 随时间的变化;逐次手动 evaluate 太密、foreground sleep 被 harness 禁、webbridge 的嵌套 JSON 响应在 git-bash 难解析(无 python3)。
**Cause**: ① 业务流入口常是 Pinia store 的 action,从 DOM 上溯组件 setupState 能拿但绕;② 定时轮询前台 sleep 被禁、嵌套 JSON 提取烦。
**Lesson**: ① **Pinia store 直取**:`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('<storeId>')`,直接调它的 action(`store.startRun(id)`)发起业务流、读 state——比从后代 DOM 上溯组件实例短(互补 [2026-06-08 从后代往上找实例])。② 轮询 evaluate **返回扁平 ASCII `|` 串**(`[status,scanned,total,...].join('|')`)而非对象,bash 侧 `grep -oE '"value":"[^"]*"'` 一把提取,免嵌套 JSON 解析。③ 定时采集用 **`run_in_background` 的 bash 循环 + `sleep`**(后台不受 foreground sleep 禁制),append 日志文件、Read 看时间线;退出条件 `if echo "$v"|grep -q '^completed|'; then break; fi`(延续 [2026-06-08 break 不跳出 for] 坑)。

## 2026-06-09: 程序化设 Vue 表单字段——被"切模式清字段"的 watcher 异步重置
**Symptom**: 一个 evaluate 里同步设 `form.exitMode='trailing_lock'` 后再设 `form.maxHold=10`,同步回读 maxHold=10 正常;但隔一次调用再提交,DTO 里 maxHold 变回 null(明明读到过 10)。
**Cause**: 组件有 `watch(exitMode){ 重置 maxHold=null }`(切出场模式时清理无关字段),Vue watcher 在 **nextTick** flush——在我同步设值之后、点保存之前才跑,把 maxHold 清了。真人先点 radio(exitMode 变)再填 maxHold,填在 watcher 之后所以不受影响;程序化"同一同步块先设触发字段后设依赖字段"恰好撞上异步重置。
**Lesson**: 程序化整体赋值时,若某字段有 watcher 会因它变化而重置依赖字段(切模式清子字段、切类型清参数),把**触发字段**和**被重置的依赖字段**放进**两次独立 evaluate**(两次 webbridge 调用间隔 >> nextTick,watcher 已 flush 完)——先设触发字段,再单独设依赖字段。提交前 payload 自检务必覆盖这类"可能被 watcher 清掉"的字段(延续 [2026-06-05 提交前先验 payload],并最好用 network detail 看真实出站 DTO,别只信组件内回读)。

## 2026-06-09: Naive n-select 下拉——虚拟滚动藏尾部选项 + 多菜单残留混 option 查询
**Symptom**: 给条件行 n-select 选新加的字段，下拉只渲染前 ~10 个（KDJ_J…MA60），列表末尾的新字段查不到；且打开第二个 select 后 `document.querySelectorAll('.n-base-select-option')` 把上一个没关的菜单选项也带进来、index 错位。
**Cause**: Naive n-select 选项数超阈值即虚拟滚动，只渲染可视窗口，末尾选项要滚动才挂 DOM。多个 select 菜单 teleport 到 body 后会共存（旧菜单未即时移除），全局 option 查询会混两个菜单。
**Lesson**: ① 找不到尾部选项先把菜单滚到底再读：`(menu.querySelector('.v-vl')||menu.querySelector('[class*=scrollbar-container]')).scrollTop=99999`。② option 一律 scope 到**可见**菜单别用全局：`[...document.querySelectorAll('.n-base-select-menu')].filter(m=>m.getClientRects().length>0).pop()` 再在它内部 querySelectorAll option 按 index 点。③ 选完回读对应 `.n-base-selection` 文本确认命中。难填的 n-date-picker daterange 仍直接设 `form.dateRange=[ms,ms]`（本地午夜 ms，减一天 `-86400000`）最稳。

## 2026-06-09: 图表区空白——数 容器children/canvas/[_echarts_instance_] 区分"没 init"vs"尺寸 0"
**Symptom**: e2e 验 ECharts 图表，图表区空白。容器 div 存在且 clientWidth/Height 非 0，但里面没图。
**Cause**: 两种成因要分开——(a) 实例根本没创建 vs (b) 创建了但 0 尺寸/空数据。本例 (a)：组件把图表容器放在 `v-if="loading"` 的互斥分支，init 在 loading 仍 true 时跑→容器不在 DOM→`el` ref undefined→`echarts.init` 被 `if(!el.value)return` 跳过，loading 转 false 后无人重触发。
**Lesson**: 图表空白先 `evaluate` 数三个值：`容器.children.length` / 容器内 `canvas` 数 / `document.querySelectorAll('[_echarts_instance_]').length`。全 0 = init 没跑（查组件 init 时机/loading 门控，直接读源码，别瞎试 resize）；有 canvas 但宽高 0 = sizing 问题（试 `window.dispatchEvent(new Event('resize'))`）。前后端定界：`evaluate` 内 `await fetch('/api/...')`（带登录 cookie）直接打接口，200+数据则 bug 在前端渲染、不在后端。

## 2026-06-08: evaluate code 里的中文字面量经 PowerShell→webbridge 传输会被破坏，字符串比较假阴性
**Symptom**: evaluate 里 `txt.indexOf('某中文')>=0` 返回 false，但页面明明渲染了该中文（snapshot/innerText 里能看到，只是显示成乱码）。换成结构性检查（`querySelectorAll('.x').length`）或 ASCII 锚点（'ths_daily'/'0AMV'/数字）立刻正常。
**Cause**: Windows PowerShell 控制台 GBK 编码，把 evaluate code **字符串里的中文字面量**在 PowerShell→JSON→daemon 传输途中搞坏，到浏览器已非原字符 → 比较恒不等。读回结果里的中文乱码只是控制台**显示**问题（浏览器内数据正确），但 code 里写死的中文是**真被破坏**。
**Lesson**: PowerShell 驱动 webbridge 时，evaluate code 里**别塞中文字面量做比较/匹配**。改用 ① 结构性事实（元素计数、class 存在、titleCount）② ASCII 锚点（接口名/数字/英文 class）③ 真要判中文用 `charCodeAt` 数组或在 JS 内部读 DOM 自比，不跨进程传中文。

## 2026-06-08: 定位 Vue 组件实例——从它渲染的后代元素往上找，别从父容器往上
**Symptom**: `document.querySelector('main').__vueParentComponent` 往上 `.parent` 找页面级组件(SignalStatsView)返回找不到；但从 modal 里的 `form` 往上找同一组件却成功。
**Cause**: `__vueParentComponent.parent` 是**祖先**链。目标组件渲染在 main **内部**(是 main 的后代)，从 main(祖先容器)往上永远到不了它。modal/form 能找到是因 modal 是该组件的**子组件**，form 链往上恰好经过它。
**Lesson**: 要 `.parent` 上溯到某页面组件实例，起点必须是**它渲染出的后代 DOM**(如 `querySelectorAll('main *')[k]` 或它特有元素)，不是父容器(main/body/#app)。稳妥写法：遍历 `querySelectorAll('main *')` 逐个 `__vueParentComponent` 上溯匹配 `type.__name`，命中即返回。

## 2026-06-08: git-bash 里 `cmd | grep -q X && break` 不跳出 for 循环
**Symptom**: 轮询脚本 `for i in ...; do st=$(...); echo "$st"|grep -q PAT && break; sleep 2; done` —— 条件早已满足却不 break，循环跑满上限才退出（webbridge runningId 早转 null，脚本仍空转数百秒）。
**Cause**: MSYS/git-bash 下 `pipeline && break` 的 break 在 pipeline 子 shell 上下文求值，不作用于外层 for 循环。
**Lesson**: 轮询退出条件别用 `cmd|grep -q && break`。先赋值再用 `if echo "$st"|grep -q X; then break; fi`，或纯 bash 字符串匹配 `[[ $st == *X* ]] && break`（无 pipeline，最稳）。

## 2026-06-08: git-bash 无 python3 —— webbridge JSON 响应改用 grep -oE 或 PowerShell
**Symptom**: `curl ... | python3 -c "json.load..."` 处理 webbridge snapshot 报 `Python was not found`（Windows 把 python3 转到 Microsoft Store 别名）。
**Cause**: Windows git-bash PATH 里没有 python3；python 经 py launcher 只在 PowerShell 可用，git-bash 调不到。
**Lesson**: git-bash 里别管道 python3 处理 webbridge JSON。截取控件 ref 用 `grep -oE '"name":"X"[^}]*"ref":"@e[0-9]+"'`；snapshot 太大时按已知锚点（"买入条件"/"保存"）grep 缩范围；要真解析 JSON 换 PowerShell `ConvertFrom-Json`。

## 2026-06-07: n-collapse / 非激活 tab 内的子组件懒渲染 —— 设 exposed ref 不会挂载它，DOM 里查无
**Symptom**: 通过组件 exposed ref 把表单值设好（`canSubmit` 已变 true），但该控件对应的子组件和它的 `v-if` 提示（如标签选择器 + 闭合警告）在 DOM 里查不到（`querySelector(...)` 返回 null）。
**Cause**: Naive UI `n-collapse-item`（同理非激活 `n-tab-pane`）的内容是**懒渲染**——首次展开才创建 DOM。折叠态下子组件压根没 mount，设父组件的 ref 只改了响应式 state，不会让折叠子树出现。
**Lesson**: 要验证活在折叠面板 / 非激活 tab 里的 UI（子控件、`v-if` 警告文案），**先展开**再查——点 `.n-collapse-item__header-main`（或 tab 头）。只设 exposed ref 不够。展开后子组件 onMounted 才跑、`v-if` 才求值。延续 [设 exposed ref 驱动难填控件]，补「折叠区需先展开」这一前提。

## 2026-06-07: git-bash curl 落 /tmp 文件再喂 Windows python 读不到 —— 改 stdin 管道
**Symptom**: `curl ... > /tmp/snap.json` 成功，紧接着 `python -c "json.load(open('/tmp/snap.json'))"` 报 `FileNotFoundError: /tmp/snap.json`。
**Cause**: git-bash 的 `/tmp` 与 Windows 上 python 解释器眼里的 `/tmp` 不是同一处（路径风格/根不一致）。中转临时文件两端对不上。
**Lesson**: git-bash 里 curl 输出要喂给 Windows python 时，**直接管道** `curl ... | python -c "import sys,json; d=json.load(sys.stdin)"`，别走临时文件。少一次落盘也少一次路径风格踩坑。

## 2026-06-06: 截图卡死数分钟 —— 目标 tab 非前台，Chrome captureVisibleTab 阻塞
**Symptom**: `screenshot` 的 curl 迟迟不返回（被 harness 转后台跑了几分钟才完成），PNG 长时间不落盘；但 daemon `status` 即时健康（running+connected），其它 `evaluate`/`snapshot` 命令也照常返回。
**Cause**: Chrome 的 captureVisibleTab 只能截"当前可见"tab。用户在看别的窗口/tab 时，webbridge 的 screenshot 会一直等到该 tab 变前台才完成 → 看似卡死；daemon 本身没坏（能并发处理其它 /command）。
**Lesson**: 驱动后台 tab 时**别依赖 screenshot**。读页面/定位元素一律用 `evaluate`（读 innerText / 组件 setupState / 元素）或 `snapshot`——不要求 tab 前台。只有需要给人看的视觉确认才截图，并预期它可能要等到 tab 切前台才返回。

## 2026-06-05: webbridge evaluate 传复杂 code —— 写 JSON 请求体到文件 + `curl -d @file`，JS 内一律单引号

**Symptom**：evaluate 的 code 稍长或含字符串时，用 `curl -d '{...}'`（shell 单引号包裹整段 JSON）反复撞转义——JSON 要用双引号包 code，code 内字符串再用双引号就得层层 `\"`；想在 code 里改用单引号又和 shell 外层单引号冲突。手工转义漏一个就 `invalid character 's' in string escape code`（本次 `/\s+/g` 同时还碰上正则字面量碎，见下条）。
**Cause**：三层嵌套（shell 引号 → JSON 字符串 → JS 字符串）转义规则叠加，curl `-d` 内联时无解。
**Lesson**：用 Write 工具把整个请求 JSON 写到临时文件，**code 内字符串一律用单引号**（JSON 值用双引号包裹，内部单引号无需转义、也不经 shell），再 `curl -s -X POST ... -d @/c/Users/.../req.json`（Windows 下 git-bash 读文件用 POSIX 路径 `/c/...`）。一步绕开 shell 转义地狱。仍需把 code 压成单行或避开正则字面量（与「正则字面量/裸换行会碎」那条配合）。用完删临时文件。

## 2026-06-05: 驱动复杂多字段表单 —— 整体走 setupState 赋值 + 提交前先验 payload

**Symptom**：要在 Naive UI modal（QuantTrainTriggerModal）填 7+ 字段（含 n-select、n-date-picker daterange）再提交，提交会启动数小时的有副作用任务。逐个驱动 UI 控件易错，n-select 下拉/日期面板尤其脆。
**Cause**：复杂控件值藏在组件 reactive state 里，UI 难填；且"填错值直接提交"代价高（不可轻易撤回的副作用）。
**Lesson**：从组件实例 `setupState` 拿 reactive `form` **直接整体赋值**（日期用本地午夜 ms 数组 `new Date(y,m,d).getTime()`），然后**提交前先 `evaluate` 调组件暴露的 `buildParams()` / 读 `canSubmit` 把最终 payload 打印出来核对**，确认无误**再调暴露的 `onSubmit()`**。把"填→盲提交"变成"填→验 payload→提交"。延续 [2026-06-02 走组件实例设 exposed ref]，多了"提交前 payload 自检"这一步。定位组件：从稳定 DOM（`.n-data-table` / `[role=dialog]`）往上 `__vueParentComponent.parent` 找到目标 `inst.type.__name`。

## 2026-06-03: navigate 后立刻截图 —— 异步数据没画完，空内容区被误判成坏页

**Symptom**：`navigate` 到某 SPA 页后马上 `screenshot`，截到的 `<main>` 一片空，看着像路由没匹配 / 组件崩了。实际 `routeMatched===1`、`main.innerHTML` 有近 2 万字符内容（一张表格），只是截图比异步 fetch 早了一拍。

**Cause**：webbridge `navigate` 在浏览器 load 事件即返回，但 SPA 的列表/表格数据是 mount 后再 `fetch` 回填的。两者之间有个窗口，截图正好落在数据回填前 → 拍到只有骨架/空态的内容区。

**Lesson**：截图前先确认内容到位，别靠「navigate 返回了」就拍。最省事的判据：`evaluate` 读 `document.querySelector('main').innerText`（或 innerHTML.length / 某已知行元素存在）非空再 `screenshot`。看到疑似空白页时，先 `evaluate` 验 innerHTML 长度 + matched，**长度大但截图空 = 截早了，重拍即可**，不是坏页（区别于 matched=0 的路由问题和子组件 Vite 500）。

## 2026-06-02: 驱动 Vue「难填」控件 —— 走组件实例直接设 exposed ref

**Symptom**：要给 `n-date-picker`（daterange）设值再触发同步。走 UI 得开日历、翻月、点日格，多个易错往返；`fill` 又因为它是格式化展示 + 需日历确认而设不进。
**Cause**：复杂控件的值不在能直接 `fill` 的 input 上，藏在组件状态里。
**Lesson**：找面板根 DOM（如 `.one-click-sync`）→ `el.__vueParentComponent`，向上 `.parent` 走到带 `exposed`（`defineExpose`）的实例，直接设它暴露的 ref（`ctrl.dateRange.value=[ms,ms]`）并读 `ctrl.steps.value` 做进度轮询——比驱动 UI 控件稳得多。日历日用本地午夜 ms（`new Date(y,m,d).getTime()`），别用 UTC。

## 2026-06-02: evaluate 的正则字面量经 curl/JSON 多层传输会碎

**Symptom**：evaluate code 里写 `str.replace(/\n/g,' ')`，daemon 报 `SyntaxError: Invalid regular expression: missing /`；再加力转义反斜杠也没用。
**Cause**：反斜杠序列穿过 shell 单引号 + JSON 字符串 + daemon 解析多层，正则字面量里的 `\n`/`/` 被打碎。
**Lesson**：evaluate 经 curl 传时避开正则字面量与裸换行——用 `String.fromCharCode(10)` 代替 `'\n'`、`split(x).join(y)` 代替 `replace(/x/g,y)`。关 Naive modal 同理：按 `aria-label==='close'` / `.n-base-close` 精确匹配，别 `querySelector('.n-modal .n-button')` 抓第一个（可能是「最大化」按钮）。

## 2026-06-02: SPA 路由卡在 `/` matched=0 —— 真因是某子组件 Vite 转换 500

**Symptom**：navigate / `router.push('/money-flow')` 后 `currentRoute.path` 一直是 `/`、`matched.length===0`、`<main>` 空白，但 `location.href` 已是目标 URL，且该路由确实在 `getRoutes()` 里。换新 tab、硬刷新都复现。`/api/auth/me` 直接 fetch 返回 200（不是登录态问题）。目标页主 chunk 的 network 请求也是 200。

**Cause**：路由懒加载的 `import()` 整体 reject（`TypeError: Failed to fetch dynamically imported module`），但**主 .vue 文件本身 200**，真正 500 的是它 import 的某个**子组件**。Vite 对编译失败的 SFC 返回 HTTP 500 + 一段内嵌 error 的 HTML，于是 `import()` 链整体失败、`beforeEach` 的 navigation 永远 resolve 不了。本例子组件 `defineProps/withDefaults` 的 default 工厂引用了 `<script setup>` 里的局部 const（`@vue/compiler-sfc` 禁止：defineProps 会被提升到 setup() 外），编译直接报错。

**Lesson**：遇到「路由 matched=0 但 URL/route 表都对、auth 也正常」，**别再怀疑 auth/guard**。两步定位：
1. 在页面 `evaluate` 里 `router.push(target).catch(e=>e.message)` —— 能直接拿到 `Failed to fetch dynamically imported module: <文件>`。
2. 对该文件**及其 import 的子组件**逐个 `curl -o /dev/null -w "%{http_code}" http://localhost:5173/src/.../X.vue`，500 的那个就是真凶；再 `curl` 它看内嵌的 `@vue/compiler-sfc` error message。
主文件 200 不代表它能用 —— 失败藏在 transitive import 里。

## 2026-05-27: 从 view 文件路径推断路由前缀

**Symptom**：因为 Vue view 文件在 `apps/web/src/views/market/MoneyFlowView.vue`，就 navigate 到 `/market/money-flow`。页面渲染出来 `<main>` 里只有空注释 `<!---->`。浪费 ~6 个 webbridge 往返追查「为啥内容空」。

**Cause**：Vue 文件目录结构 ≠ Vue Router 路径。实际路由是 `/money-flow`（无 `/market` 前缀）。`routeMatched` 是空数组 —— 明显信号但我没第一时间查。

**Lesson**：首次 navigate 之前，先查 `$router.getRoutes()`（Vue）或框架等价物枚举真实路径。不要从文件位置推 URL。如果 navigate 后看到空白页，先查 `$router.currentRoute.value.matched.length === 0` 再下「JS 错误」结论。

---

## 2026-05-27: kimi-webbridge daemon 卡在残留 PID 文件

**Symptom**：`status` 返回 `{"running": false, "pid": 7224, ...}`。`start` 失败：`open ...daemon.pid: The file exists`。`restart` 报「daemon started (pid X)」但下一次 status 仍 false。

**Cause**：daemon 进程死了（crash 或被 kill）但没清 PID 文件。`start` 不会覆盖。`restart` 试图通过 HTTP 停掉旧（已死）进程，被 connection refused，然后 `start` 撞上同样的 PID 冲突。

**Lesson**：碰到「running:false 但 pid 有值」的状态，别再反复 `start` / `restart`。要么：
- 读 `~/.claude/skills/kimi-webbridge/references/operations.md` 拿官方路由表
- 或直接 `rm ~/.kimi-webbridge/daemon.pid && ~/.kimi-webbridge/bin/kimi-webbridge start`

---

## 2026-05-27: Windows 上 webbridge 截图路径风格

**Symptom**：给 `screenshot` 传 `path: "C:\\Users\\X\\AppData\\Local\\Temp\\shot.png"`。报错 `invalid character 'U' in string escape code`。再加力转义反斜杠也没用。

**Cause**：Windows 风格路径在 JSON 字符串解析时很脆，反斜杠序列让 daemon 的 JSON parser 出错，curl 端怎么转义都救不回来。

**Lesson**：webbridge 的所有文件输出参数（`screenshot` / `save_as_pdf` / 等等）一律传 POSIX 路径（`/tmp/shot.png`）。在 Windows 上，daemon 会写到 `C:\tmp\` 下对应位置。用 Read 工具读回时用 Windows 路径（`C:\tmp\shot.png`）。

---

## 2026-05-27: 登录跳转吃掉首次导航

**Symptom**：首次 `navigate` 到 `/market/money-flow` 静默被踢到 `/login?redirect=...`。浪费一个回合才意识到。

**Cause**：真实浏览器 session 没有有效 auth cookie。auth guard 在路由组件 mount 前就拦了。

**Lesson**：对任何受保护应用，navigate 到目标页之前：
1. 先开主页或一个已知安全的 URL。
2. 检查登录态 —— 在 DOM 里看用户名，或调一个 auth-status 接口。
3. 未登录就让用户在持久 session 里手动登录一次。不要自己填凭据 —— 你没密码，CAPTCHA / MFA 会让这条路彻底走不通。

---

## 2026-05-27: @e 元素 ref 跨快照重新编号

**Symptom**：snapshot 显示 tabs 是 `@e13`/`@e14`/`@e15`（大盘/行业/板块）。点 `@e15` 想跳「板块」，实际跳到别的 tab —— 因为两次 snapshot 之间 tab 列表已重新渲染，ref 整体偏移一位。

**Cause**：`@e` ref 是当前快照内的位置标识，不是稳定 ID。任何 DOM 改动（路由切换、modal 开关、tab 切换、列表异步重渲）都会重洗 ref。

**Lesson**：新 DOM 状态下，每次点击之前立刻重 snapshot。如果把 click + screenshot 批量执行而中间不重 snapshot，就会在过期 ref 上操作。Ref 仅在单次 snapshot 的生命周期内有效。

---

## 2026-05-27: `network detail` 不一定返回 requestBody

**Symptom**：想验证前端 apply 筛选后发出的 POST body。调 `network detail` 看捕获的请求，响应里有 `body`（响应体）但没有 `requestBody` 字段。

**Cause**：webbridge 的 network 抓包能稳定拿到响应体，但请求体覆盖取决于 Chrome devtools 的时序 —— 某些请求类型可能漏掉。

**Lesson**：别只靠 `network detail` 验证出站 payload。回退方案：
1. 后端 server 日志（NestJS / Django / Rails 常会打印解析后的 body 或至少路由）。
2. 在 `evaluate` 里改写 fetch，发送前 `console.log(JSON.stringify(body))`。
3. 反向核对响应形态：如果筛选结果正确收窄，body 大概就是对的。

---

## 2026-06-10: 页面在 evaluate 进行中被销毁 → daemon 永久挂起，后续命令排队

**Symptom**：之前一直正常的 `evaluate` 突然永不返回（curl 被迫转后台/超时），再发的 evaluate 也卡；但 `list_tabs` 等不触碰页面的命令秒回。

**Cause**：evaluate 在页面上下文执行期间页面被销毁/刷新（如 dev server 重启后 vite 重连触发 reload），回调永远不会回来；daemon 对该 session 的后续页面命令排在悬空命令之后。

**Lesson**：dev server 重启后，先 `navigate`（同 session 复用 tab）强制重载一次页面再继续 evaluate。已卡住时同样用 `navigate` 复位页面上下文（list_tabs 可用来确认 daemon 本身活着），然后用 `1+1` 试探 evaluate 恢复后再发正式命令；对有副作用的命令（POST 创建等），复位后先查目标状态防止重复执行。

## 2026-06-11: bash 轮询循环里 grep 嵌套转义 JSON 終態失配致空转
**Symptom**: 用 bash for 循环轮询 webbridge evaluate 返回的 JSON，`grep -qE '\\\\"status\\\\":\\\\"success'` 永不命中，任务早已 success 仍空转满 60 轮（浪费 5 分钟）。
**Cause**: webbridge 返回体是双层 JSON（外层 daemon 包裹+内层 evaluate 字符串），引号转义层数在 bash 单引号/双引号/JSON 三层嵌套下极易数错。
**Lesson**: 轮询终态判定不要精确匹配转义引号——用宽松子串（`grep -qE 'success|failed'` 匹配裸词）或先 sed 提取 value 字段再比较；写完先手测一轮 grep 是否真能命中样本输出。

## 2026-06-19: Naive UI 复杂输入框（n-input-number）直接改 DOM value 不触发 v-model，改组件 setupState 更稳
**Symptom**: e2e 给 KDJ 参数编辑器（n-input-number）设新值：直接改 `<input>.value` 并 dispatch input/change 事件，点确定后发出的仍是旧值，localStorage 也没持久化到新参数。
**Cause**: n-input-number 等 Naive 组件的 model 由组件自身维护，内部 input 的 value 只是展示；外部改 DOM 值不会触发 `update:value`，confirm 读到的还是组件 state 里的旧数。
**Lesson**: 对难驱动的 Vue 控件，定位到组件根 DOM 后取 `el.__vueParentComponent.setupState`，直接改其 reactive 状态（如 `draft.n = 6`）或调用 `<script setup>` 里声明的方法（如 `inst.setupState.onConfirm()`）。这比模拟 UI 输入更稳，也不依赖 `defineExpose`——setupState 里的函数和响应式对象天然可读写。

## 2026-06-19: 后端 dev 没热加载时，浏览器 e2e 命中 404 要先重启 server
**Symptom**: e2e 点确定后前端 POST `/api/klines/.../recalc` 返回 404，但代码里明明有该路由；单元测试和构建都通过。
**Cause**: 项目后端 `nest start` 不带 watch，已运行的 dev server 还是旧进程，新接口没加载。
**Lesson**: 浏览器验证前先确认后端是最新代码。若 404/行为异常且代码已存在，优先 `netstat` 找端口对应 PID，杀掉后重新 `pnpm --filter @cryptotrading/server dev`，再开始 e2e。
