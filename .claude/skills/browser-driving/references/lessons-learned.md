# Browser Driving — 累积经验

每条都是真实驱动浏览器时撞到的具体障碍 + 萃取出来的结论。**开始浏览器工作前扫一遍；结束后追加**（按 SKILL.md 里的复盘协议）。

最新条目置顶。

---

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
