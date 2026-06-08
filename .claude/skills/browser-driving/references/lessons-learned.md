# Browser Driving — 累积经验

每条都是真实驱动浏览器时撞到的具体障碍 + 萃取出来的结论。**开始浏览器工作前扫一遍；结束后追加**（按 SKILL.md 里的复盘协议）。

最新条目置顶。

---

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
