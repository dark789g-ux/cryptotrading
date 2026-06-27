# Playwright 浏览器测试 — 累积经验

每条都是真实驱动浏览器时撞到的具体障碍 + 萃取出来的结论。**开始前扫一遍；结束后追加。**
格式：`## YYYY-MM-DD: 一行标题` / **Symptom** / **Cause** / **Lesson**（每条 4–6 行，便于扫读）。
只放**通用浏览器/Playwright 经验**；项目特定事实（某页路由、某字段口径）进项目 memory / CLAUDE.md，别混进来。

最新条目置顶。

---

## 2026-06-27: naive-ui n-checkbox 状态判勾选需看 className，别找 input[type='checkbox']
**Symptom**: ColumnSettingsDrawer 里点击列项的 checkbox 无法 toggle，用 `locator("input[type='checkbox']")` 找不到元素，`is_checked()` 也报空。
**Cause**: naive-ui `n-checkbox` 是自定义组件，不渲染原生 `<input type="checkbox">`；勾选状态通过外层 `.n-checkbox` 的 `n-checkbox--checked` class 体现。
**Lesson**: 操作 naive-ui checkbox 时：1) 定位 `.n-checkbox` 元素点击 toggle；2) 通过 `el.className.includes("n-checkbox--checked")` 判状态；3) 别试图找原生 input 或 `.n-checkbox__dot--checked`（旧版本可能不同）。

## 2026-06-26: naive-ui n-collapse 默认折叠分组内的 checkbox 需先展开再定位
**Symptom**: 列设置 dialog 里「其它」分组的 checkbox（净流入/大单净流入等）用 `dialog.locator(".n-checkbox").all_inner_texts()` 只返回 `['\xa0', ...]`，filter(has_text="净流入") 找不到。
**Cause**: `n-collapse` 默认折叠非 `DEFAULT_EXPANDED_GROUPS` 的分组，折叠状态下子 DOM 不渲染或文本提取不到。
**Lesson**: 操作折叠分组内的元素前，先点击 `.n-collapse-item__header` 展开分组；展开后再用 `.column-settings-grid-item` filter 定位具体列项。列设置 dialog 是 `n-modal`（`[role='dialog']`），不是 `.n-drawer`。

## 2026-06-26: 要常驻浏览器逐步交互/跑完别关 → connect_over_cdp attach，别一脚本一浏览器
**Symptom**: 想「跑一步看结果再决定下一步、浏览器全程别关」或「跑完停在终态复核」，但每个 `python xxx.py` 进程退出浏览器就关，下个脚本是全新浏览器、丢掉页面/登录/交互态。
**Cause**: `chromium.launch()` 起的浏览器绑当前进程生命周期，`with sync_playwright()` 块退出即杀。
**Lesson**: 后台 `serve.py` 用 `launch_persistent_context(.user-data/<port>, args=['--remote-debugging-port=<port>'])` 持有 headed 浏览器并 hold；前台每步/每个 flow `connect_over_cdp("http://127.0.0.1:<port>")` attach，`browser.close()` **只断 CDP、不杀浏览器**，跑完停在终态。并行靠不同 `--port`（端口即实例，独立 profile，各连各端口避开多客户端 CDP 不确定性）。关实例只能 `TaskStop` serve 进程，不是脚本里的 `close()`。

## 2026-06-25: naive-ui n-date-picker input 是 readonly，不能直接 fill
**Symptom**: `page.locator('.n-date-picker input').fill('2026-06-24')` 抛 TimeoutError「element is not enabled」。
**Cause**: naive-ui `n-date-picker` 的 input 元素带 `disabled readonly` 属性，是只读展示而非可编辑输入框。
**Lesson**: 对 n-date-picker 不要直接 fill input。稳定做法：1) 用 `page.evaluate` 通过 `__vueParentComponent` 链找到 DatePicker 组件调 `exposed.setValue([ms1, ms2])`；2) 或点击打开日历面板后用键盘输入。优先 evaluate 设值，避免处理日历 UI 的复杂交互。

## 2026-06-25: 文件路径 ≠ Vue Router 路由路径
**Symptom**: 因为组件在 `views/market/MoneyFlowView.vue` 就 `goto('/market/money-flow')`，页面 `<main>` 空。
**Cause**: 文件目录结构和路由表无关，实际路由可能是 `/money-flow`（无 `/market` 前缀）。
**Lesson**: 首次导航前先 `python scripts/routes.py` 枚举真实路由；别从文件位置猜 URL。

## 2026-06-25: 导航后页面空白 ≠ 坏页，多半是异步数据没回填
**Symptom**: `goto` 返回后立刻读/截图，`<main>` 空，像路由没匹配或组件崩。
**Cause**: SPA 列表/表格在 mount 后才 fetch 回填，导航 load 事件早于数据回填。
**Lesson**: 用 `dump.py` 看 `matched`（=0 才是路由问题）与 `mainTextLen`；`_common.wait_ready` 已等 networkidle，仍空就 `page.wait_for_selector(目标行)` 再断言/截图。

## 2026-06-25: ECharts v5 实例读不到 DOM —— 验证渲染改走数据层
**Symptom**: 想读图表 `getOption()` 验 series 颜色，`el.__echarts__` / `window.echarts` 全空。
**Cause**: ECharts v5 把实例存内部 WeakMap，DOM 上不留可枚举引用；业务用 ES module 不挂 window。
**Lesson**: 别从 DOM 抠实例。判「图渲染了」数 `canvas` / `[_echarts_instance_]` 计数（`dump.py` 已含）；验 option 用 `page.evaluate("await import('/src/.../mod.ts')")` 动态导入纯函数喂真实数据断言返回值，或 `page.request.get` 打后端拿原始数据另行核对。

## 2026-06-25: 本环境 Read 图片不渲染给模型 —— 肉眼截图验证不可行
**Symptom**: 截图存下来想「看一眼对不对」，但 Read 图片在本 harness 不渲染给模型。
**Cause**: harness 限制，截图经 Read 只上传不可视。
**Lesson**: 一切验证走程序化断言：Playwright `expect`/`get_by_role`/`get_by_text`、`page.request.get` 打后端、`page.evaluate` 读结构性事实。截图仅留证 / 交付给人看，别当验证手段。

## 2026-06-25: 中文经 PowerShell 命令行传参会 GBK 损坏 —— 中文写进 .py 源
**Symptom**: `python eval.py /x "<含中文的JS>"` 里中文到浏览器变乱码，字符串比较恒不等。
**Cause**: Windows PowerShell 控制台 GBK，命令行参数里的中文在传给 python 途中被破坏。
**Lesson**: 中文定位器 / 比较串写进 `.py` 或 `.js` **文件**（UTF-8 源直读安全），用 `eval.py <route> <jsfile>` 读文件，不要从命令行传中文参数。
