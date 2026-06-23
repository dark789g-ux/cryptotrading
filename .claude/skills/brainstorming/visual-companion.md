# 视觉伴侣指南（Visual Companion Guide）

基于浏览器的视觉 brainstorming 伴侣，用于展示 mockup、图示和选项。

## 何时使用

按问题逐题判断，不要按会话整体判断。判定标准：**用户"看到"它是否比"读"它更易理解？**

**走浏览器** —— 当内容本身就是视觉的：

- **UI mockup** —— wireframe、布局、导航结构、组件设计
- **架构图** —— 系统组件、数据流、关系图
- **并排视觉对比** —— 对比两种布局、两种配色、两种设计方向
- **设计打磨** —— 当问题关于观感、留白、视觉层级
- **空间关系** —— 状态机、流程图、以图示呈现的实体关系

**走终端** —— 当内容是文本或表格性的：

- **需求与范围类问题** —— "X 是什么意思？"、"哪些功能在范围内？"
- **概念性 A/B/C 选择** —— 在用文字描述的方案之间挑一个
- **权衡列表** —— 优缺点、对比表
- **技术决策** —— API 设计、数据建模、架构方法选型
- **澄清式问题** —— 任何答案是文字而非视觉偏好的问题

关于 UI 话题的问题并**不自动**等于视觉问题。"你想要哪种 wizard？"是概念性的 —— 走终端。"这几种 wizard 布局里哪个感觉对？"是视觉性的 —— 走浏览器。

## 工作原理

服务器监听一个目录中的 HTML 文件，并把最新一份提供给浏览器。你把 HTML 内容写到 `screen_dir`，用户在浏览器中看到它并可点击选择选项。选择被记录到 `state_dir/events`，你在下一轮读取即可。

**内容片段 vs 完整文档：** 如果你的 HTML 文件以 `<!DOCTYPE` 或 `<html` 开头，服务器会原样提供（仅注入 helper 脚本）；否则服务器会自动把你的内容包进 frame 模板 —— 加上头部、CSS 主题、选中指示器和所有交互基础设施。**默认写内容片段**。只有在你需要对整张页面完全掌控时才写完整文档。

## 启动一个会话

```bash
# 启用持久化启动服务器（mockup 保存进项目目录）
scripts/start-server.sh --project-dir /path/to/project

# 返回内容示例：{"type":"server-started","port":52341,"url":"http://localhost:52341",
#           "screen_dir":"/path/to/project/.superpowers/brainstorm/12345-1706000000/content",
#           "state_dir":"/path/to/project/.superpowers/brainstorm/12345-1706000000/state"}
```

保存返回中的 `screen_dir` 和 `state_dir`。告诉用户打开返回的 URL。

**查找连接信息：** 服务器会把启动 JSON 写到 `$STATE_DIR/server-info`。如果你后台启动了服务器且没拿到 stdout，读这个文件就能拿到 URL 和端口。使用 `--project-dir` 时，到 `<project>/.superpowers/brainstorm/` 下找会话目录。

**注意：** 把项目根作为 `--project-dir` 传入，这样 mockup 会持久保存在 `.superpowers/brainstorm/` 下并在服务器重启后仍可用。不传则文件落到 `/tmp` 并会被清理。提醒用户如果 `.gitignore` 里还没有 `.superpowers/`，要加进去。

**按平台启动服务器：**

**Claude Code（macOS / Linux）：**
```bash
# 默认模式即可 —— 脚本自身会把服务器放到后台
scripts/start-server.sh --project-dir /path/to/project
```

**Claude Code（Windows）：**
```bash
# Windows 会自动检测并切到前台模式，从而阻塞该工具调用。
# 在 Bash tool 调用上设置 run_in_background: true，让服务器
# 在多轮对话之间保持存活。
scripts/start-server.sh --project-dir /path/to/project
```
通过 Bash tool 调用时，设置 `run_in_background: true`。然后在下一轮读取 `$STATE_DIR/server-info` 以拿到 URL 与端口。

**Codex：**
```bash
# Codex 会回收（reap）后台进程。脚本会自动检测 CODEX_CI
# 并切到前台模式。直接正常运行，无需额外参数。
scripts/start-server.sh --project-dir /path/to/project
```

**Gemini CLI：**
```bash
# 使用 --foreground，并在 shell tool 调用上设 is_background: true
# 让进程在多轮之间保持存活
scripts/start-server.sh --project-dir /path/to/project --foreground
```

**其它环境：** 服务器必须在多轮对话之间持续在后台运行。如果你的环境会回收脱离的进程，使用 `--foreground` 并通过当前平台的后台执行机制启动该命令。

如果浏览器无法访问该 URL（在远程 / 容器化环境中很常见），绑定一个非 loopback 主机：

```bash
scripts/start-server.sh \
  --project-dir /path/to/project \
  --host 0.0.0.0 \
  --url-host localhost
```

用 `--url-host` 控制返回 JSON 中打印的主机名。

## 循环（The Loop）

1. **检查服务器是否存活**，然后**把 HTML 写到 `screen_dir` 中的一个新文件**：
   - 每次写入前先确认 `$STATE_DIR/server-info` 存在。如果不存在（或 `$STATE_DIR/server-stopped` 存在），说明服务器已停 —— 先用 `start-server.sh` 重启再继续。服务器在闲置 30 分钟后会自动退出。
   - 使用语义化文件名：`platform.html`、`visual-style.html`、`layout.html`
   - **不要复用文件名** —— 每屏都使用一个新文件
   - 使用 Write 工具 —— **不要用 cat / heredoc**（会往终端倒一堆噪音）
   - 服务器会自动提供最新一份文件

2. **告诉用户该期待什么，然后结束本轮：**
   - 每一步都提醒一次 URL（不只是第一步）
   - 用简短文字概述当前屏在展示什么（如 "正在展示首页的 3 种布局选项"）
   - 让用户在终端中回复："看一下，告诉我你的想法。想选某个选项的话点一下即可。"

3. **下一轮 —— 在用户于终端回复后：**
   - 如果 `$STATE_DIR/events` 存在，读取它 —— 里面是用户在浏览器中的交互（点击、选择），按 JSON Lines 存储
   - 把它和用户的终端文本合并，得到完整画面
   - 终端消息是主要反馈；`state_dir/events` 提供结构化交互数据

4. **迭代或前进** —— 如果反馈是要修改当前屏，写一份新文件（如 `layout-v2.html`）。只有在当前一步通过校验后才进入下一个问题。

5. **回到终端时卸载（unload）** —— 当下一步不再需要浏览器（例如澄清式问题、权衡讨论），推一张"等待屏"以清掉过时内容：

   ```html
   <!-- filename: waiting.html (或 waiting-2.html 等) -->
   <div style="display:flex;align-items:center;justify-content:center;min-height:60vh">
     <p class="subtitle">Continuing in terminal...</p>
   </div>
   ```

   这能避免对话已经往前走了，用户还盯着一个已经定下来的选择看。下次有新的视觉问题时，照常推一份新内容文件。

6. 重复直到结束。

## 编写内容片段（Writing Content Fragments）

只写"放在页面里的那部分内容"。服务器会自动把它包进 frame 模板（头部、主题 CSS、选中指示器和所有交互基础设施）。

**最小示例：**

```html
<h2>Which layout works better?</h2>
<p class="subtitle">Consider readability and visual hierarchy</p>

<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content">
      <h3>Single Column</h3>
      <p>Clean, focused reading experience</p>
    </div>
  </div>
  <div class="option" data-choice="b" onclick="toggleSelect(this)">
    <div class="letter">B</div>
    <div class="content">
      <h3>Two Column</h3>
      <p>Sidebar navigation with main content</p>
    </div>
  </div>
</div>
```

就这些。不需要 `<html>`、不需要 CSS、不需要 `<script>` —— 服务器会提供。

## 可用的 CSS 类（CSS Classes Available）

frame 模板为你的内容提供以下 CSS 类：

### Options（A/B/C 选项）

```html
<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content">
      <h3>Title</h3>
      <p>Description</p>
    </div>
  </div>
</div>
```

**多选：** 在容器上加 `data-multiselect`，允许用户选择多个选项。每次点击切换该项。指示器栏会显示数量。

```html
<div class="options" data-multiselect>
  <!-- 同样的 option 标记 —— 用户可勾选 / 取消多个 -->
</div>
```

### Cards（视觉设计）

```html
<div class="cards">
  <div class="card" data-choice="design1" onclick="toggleSelect(this)">
    <div class="card-image"><!-- mockup 内容 --></div>
    <div class="card-body">
      <h3>Name</h3>
      <p>Description</p>
    </div>
  </div>
</div>
```

### Mockup 容器

```html
<div class="mockup">
  <div class="mockup-header">Preview: Dashboard Layout</div>
  <div class="mockup-body"><!-- 你的 mockup HTML --></div>
</div>
```

### Split view（并排视图）

```html
<div class="split">
  <div class="mockup"><!-- 左 --></div>
  <div class="mockup"><!-- 右 --></div>
</div>
```

### Pros/Cons（优缺点）

```html
<div class="pros-cons">
  <div class="pros"><h4>Pros</h4><ul><li>Benefit</li></ul></div>
  <div class="cons"><h4>Cons</h4><ul><li>Drawback</li></ul></div>
</div>
```

### Mock 元素（wireframe 构件）

```html
<div class="mock-nav">Logo | Home | About | Contact</div>
<div style="display: flex;">
  <div class="mock-sidebar">Navigation</div>
  <div class="mock-content">Main content area</div>
</div>
<button class="mock-button">Action Button</button>
<input class="mock-input" placeholder="Input field">
<div class="placeholder">Placeholder area</div>
```

### 排版与分节

- `h2` —— 页面标题
- `h3` —— 段落标题
- `.subtitle` —— 标题下方的次级文本
- `.section` —— 带下外边距的内容块
- `.label` —— 小号大写标签文本

## 浏览器事件格式（Browser Events Format）

当用户在浏览器中点选项时，交互会被记录到 `$STATE_DIR/events`（每行一个 JSON 对象）。每次推送新屏时该文件会自动清空。

```jsonl
{"type":"click","choice":"a","text":"Option A - Simple Layout","timestamp":1706000101}
{"type":"click","choice":"c","text":"Option C - Complex Grid","timestamp":1706000108}
{"type":"click","choice":"b","text":"Option B - Hybrid","timestamp":1706000115}
```

完整事件流展示了用户的探索路径 —— 他们可能在最终敲定前点过多个选项。最后一次 `choice` 事件通常就是最终选择，但点击模式可以揭示出值得追问的犹豫或偏好。

如果 `$STATE_DIR/events` 不存在，说明用户没和浏览器交互 —— 只用他们的终端文本即可。

## 设计建议（Design Tips）

- **保真度与问题匹配** —— 布局问题用 wireframe，打磨问题用更精致的呈现
- **每页都解释问题** —— "哪种布局更显专业？"，而不是只写 "Pick one"
- **先迭代再前进** —— 如果反馈是要改当前屏，先写一份新版本
- **每屏最多 2-4 个选项**
- **必要时使用真实内容** —— 给摄影作品集做布局时，使用真实图（Unsplash）。占位内容会掩盖设计问题。
- **保持 mockup 简洁** —— 聚焦布局与结构，而不是像素级精修

## 文件命名（File Naming）

- 使用语义化名称：`platform.html`、`visual-style.html`、`layout.html`
- 不要复用文件名 —— 每屏都必须是一个新文件
- 迭代时追加版本后缀：`layout-v2.html`、`layout-v3.html`
- 服务器按修改时间提供最新一份

## 清理（Cleaning Up）

```bash
scripts/stop-server.sh $SESSION_DIR
```

如果会话使用了 `--project-dir`，mockup 文件会保留在 `.superpowers/brainstorm/` 下以便日后参考。只有 `/tmp` 的会话会在停止时被删除。

## 参考（Reference）

- Frame 模板（CSS 参考）：`scripts/frame-template.html`
- Helper 脚本（客户端）：`scripts/helper.js`
