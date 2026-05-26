---
name: browser-driving
description: 任何需要驱动浏览器的任务都用此 skill —— UI 验证、网页自动化、截图、带登录态抓取、代码改动手测。用户提到打开浏览器、在浏览器里测 UI、截网页、在运行中的应用里验证、或任何 web 交互时都触发。需与具体工具 skill（如 kimi-webbridge，负责工具 API 机制）**并用**；本 skill 提供策略层和任务结束时的强制复盘协议，把新经验沉淀到 references/lessons-learned.md。任何浏览器任务**第一时间**读本 skill —— 里面的经验都是真实踩坑换来的，不该再踩第二次。
---

# Browser Driving（浏览器驱动）

高效驱动浏览器的策略指南。配合具体浏览器工具 skill（最常用的是 `kimi-webbridge`）使用。工具 skill 负责 API 机制，本 skill 负责策略 + 跨会话累积经验。

## 这个 skill 为什么存在

每次浏览器任务都有一长串可避免的弯路：从文件路径猜错 URL、daemon 卡死在残留 PID、没预判到登录跳转、点击后元素 ref 被重新编号、Windows 截图路径风格不对……每个弯路都要 1–5 个往返。任务结束时的复盘协议会把任何新弯路抽成一条经验，下一次会话从更聪明的起点开始。

## Pre-flight（按顺序做完再开干）

1. **用一句话写出目标。**「验证筛选发送的 POST body 正确」可执行；「测 UI」不可执行。目标不锐利就会乱点，截图堆一堆。

2. **快速扫一遍 `references/lessons-learned.md`。** 每条都是真实踩过的坑。任何条目跟当前任务形态匹配（Vue + 鉴权、Windows 截图、SPA 路由），都先把它的结论用上。这是会话里性价比最高的 60 秒。

3. **浏览器工具健康检查。** 对 `kimi-webbridge`：`~/.kimi-webbridge/bin/kimi-webbridge status` —— 确认 `running: true` **且** `extension_connected: true`。任何一个 false 都先修，别直接 navigate。daemon 卡死见 `references/lessons-learned.md` 里 2026-05-27 PID 文件那条。

## 行动前先发现

不要假设 —— 去查。查很便宜，调试很贵。

- **路由**：Vue SPA → `document.querySelector('#app').__vue_app__.config.globalProperties.$router.getRoutes()`。React Router v6+ → 用 DevTools hook 或读 nav 里的 `<a>` href。服务端渲染 → 点导航菜单别手敲 URL。**文件路径 ≠ 路由路径** —— `views/market/Foo.vue` 实际可能挂在 `/foo` 而不是 `/market/foo`。

- **元素**：优先用 `snapshot` 返回的 `@e` ref，少用手写 CSS 选择器。`@e` ref 基于语义角色 + 名称，能扛住 class hash 变化。

- **登录态**：导航到任何受保护页面之前，先 fetch 已知的鉴权状态接口，或在 DOM 里看是否有用户名标识。如果需要登录，让用户在持久浏览器会话里手动登录一次 —— 别自己填密码（你没有密码，并且 CAPTCHA/MFA 会让流程脆弱）。

如果 navigate 之后看到 `<main>` 空白，**先检查 `routeMatched`** 再下结论说是 JS 错误：
```js
$router.currentRoute.value.matched.length === 0  // 路由没注册
```

## 元素交互卫生

- `snapshot` 返回的 `@e` ref **在多次快照间不稳定**。任何改变 DOM 的动作（路由切换、modal 开关、tab 切换、点击触发的显隐）都会让 ref 重新编号。**新 DOM 状态下点击前先重新 snapshot。** 如果点击「成功」但效果不对，第一怀疑就是用了过期 ref。

- `fill` 是 clear-and-insert。要追加内容先用 `evaluate` 读出当前值，拼好再 `fill`。

- 「按 Enter」/ 提交表单：直接点提交按钮。没有键盘事件工具。

- 如果两次 snapshot 感觉操作在不同页面，用 `find_tab` 确认当前活动 tab。

## Network 抓包的局限

- `network start --filter` 要在触发请求的动作**之前**调，不是之后。
- `network detail` 通常返回响应 `body`，但 `requestBody` 不一定有。如果需要验证发出的请求体：
  1. 读后端 server 日志（常能看到解析后的 body）。
  2. 在 `evaluate` 里改写 fetch，发送前 `console.log(JSON.stringify(body))`。
  3. 反向核对响应形态 —— 如果筛选结果正确收窄，body 大概就是对的。

## Windows 路径风格规约

Windows 上跨工具会有路径风格冲突：

| 场景 | 风格 | 示例 |
|---|---|---|
| `screenshot` / `save_as_pdf` 的 `path` 参数 | POSIX | `/tmp/shot.png` |
| Read 工具读回这个文件 | Windows | `C:\tmp\shot.png` |

JSON 序列化的 Windows 路径（`C:\\Users\\...`）在 webbridge daemon 里会触发 "invalid escape" 错误。工具入参一律 POSIX；daemon 会写到对应的 Windows 位置。

## Session 卫生

- 用 `session:"<短名>"` 隔离每个任务的 tab 组。无关任务不要复用 session 名。
- **任务结束：`close_session`。** 用户的浏览器是共享资源，用完收摊。

## 强制复盘协议

报告浏览器任务完成**之前**走完这套复盘。这是让本 skill 持续复利的循环。

### Step 1 — 列出具体障碍

什么地方卡住了？要具体。「花了点时间」不是经验。「因为文件在 `views/market/` 就假设路由是 `/market/foo`，实际是 `/foo`，浪费 6 个往返」才是经验。

### Step 2 — 给每条分类

| 类型 | 示例 | 落地位置 |
|---|---|---|
| **通用** | 工具 quirk、框架发现技巧、OS 路径风格 | `references/lessons-learned.md`（本 skill） |
| **项目特定** | 「本项目路由没有业务域前缀」「A 股 trade_date 是 YYYYMMDD」 | 项目 memory 或项目 CLAUDE.md —— **不放本 skill** |
| **一次性** | 用户忘密码、网络瞬断 | 忽略 |

分类很重要：把项目特定事实塞进通用 skill 会污染其它项目的经验。

### Step 3 — 通用经验追加进 lessons-learned

按下面格式追加到 `references/lessons-learned.md`：

```markdown
## YYYY-MM-DD: <一行标题>
**Symptom**: 表面看到的现象（让未来的会话能按模式匹配认出来）
**Cause**: 实际成因
**Lesson**: 下次具体怎么做
```

每条精简到 4–6 行。这个文件就是用来扫读的。

### Step 4 — 在最终汇报里告知

在任务最终汇报里写一句「Retrospect: 追加 N 条经验到 browser-driving skill」（或「无新经验」如果所有弯路都是一次性 / 项目特定的）。这个信号让用户知道 skill 在演化，也给用户一个推回某条「经验」其实是错的机会。

### 何时**不**追加

- 经验只是复述 SKILL.md 里已有的内容或已有条目。
- 「经验」是「我应该读文档」—— 那就读文档，别写元经验。
- 行为已经被其它 skill 覆盖（比如 kimi-webbridge 自己的 operations.md 已经处理了 daemon 恢复）。

**防膨胀**：如果 `references/lessons-learned.md` 变长（≥50 条左右），做一次合并整理 —— 合并重复、删过时、按主题分组。
