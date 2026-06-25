# .browser-driving — 前端浏览器测试脚本库（Python + Playwright）

cryptotrading 前端的浏览器自动化 / e2e 测试脚本库。用 **Python + Playwright** 驱动一个独立 Chromium，
程序化登录后做 UI 验证、抓数据、截图。目的：把每次测试都要重写的样板（登录、导航、查路由、体检页面、截图）
固化成可复用脚本，**开箱即用、少试错**。

> 与 webbridge 的区别：Playwright 跑**自己的全新浏览器**（无你的登录态），所以靠 `config.json` 里的账号密码
> **程序化登录**，把会话 cookie 存进 `storage_state.json` 给后续脚本复用。

## 一次性 setup

```bash
# 1. 复制配置模板并填真实账号密码（config.json 不入库）
cp .browser-driving/config.example.json .browser-driving/config.json
#    编辑 config.json 的 email / password

# 2. 装浏览器二进制（Python 包 playwright 已装；这步幂等）
python -m playwright install chromium

# 3. 确保应用在跑（另开终端）：web :5173 + server :3000
pnpm dev
```

> 本机：git-bash 里 `python` 直接可用（Python 3.10.11），`python3` 是 Microsoft Store 别名不可用。

## config.json 字段

| 键 | 说明 |
|---|---|
| `baseUrl` | 前端地址，默认 `http://localhost:5173` |
| `apiBaseUrl` | 后端 API，默认 `http://localhost:3000/api`（缺省时按 baseUrl 推） |
| `email` / `password` | 登录账号密码（**明文，gitignore**） |
| `rememberMe` | 登录勾「记住我」（cookie TTL 30 天） |
| `headless` | `true`=无窗口（默认，快）；`false`=弹出可见浏览器调试 |
| `slowMoMs` | 每步放慢毫秒（headed 调试用） |
| `defaultTimeoutMs` | Playwright 默认超时 |
| `cdpPort` | 常驻浏览器(serve/attach)的 CDP 端口，默认 9222；端口即并行实例标识 |

## 常驻浏览器交互模式 + 固化重放闭环（测试主线）

默认的 `logged_in_page` 是「一脚本一浏览器、用完即关」，适合纯断言/CI。但**交互式测试**要「到页面→观察→
可能继续/复核」，且常要「跑一步看结果再决定下一步」——这需要浏览器**常驻**。机制：后台 `serve` 进程持有一个
headed 持久浏览器并开 CDP 端口，前台每步/每个流程 `attach` 它（`browser.close()` 只断连、不杀浏览器）。

### 三步用法
1. **起常驻底座**（后台，务必 run_in_background）：`python scripts/serve.py [--port 9222]` → 等 `BROWSER_UP`。
   起之前先 `python scripts/peek.py [--port N]` 探测：连得上就复用、别重复起。
2. **探索**（路径未知，边看边走）：写 `.browser-driving/.tmp/step.py`：
   ```python
   import sys, pathlib                                    # .tmp/ 是 scripts/ 兄弟目录
   sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
   from playwright.sync_api import sync_playwright
   from _common import attach, goto_route
   with sync_playwright() as p:
       browser, ctx, page = attach(p, port=9222)  # 连常驻浏览器，拿当前页
       goto_route(page, "/backtest")
       print(page.url, page.locator("table tbody tr").count())
       browser.close()                             # 只断连，浏览器不动
   ```
   跑→看 stdout→改 step.py→再跑，浏览器全程停在上一步状态。
3. **固化重放**：探索走通后，把整条步骤固化成 `flows/<任务>.py`（见 `flows/README.md`），下次
   `python flows/<任务>.py [--port N]` **一步到位**，跑完停在终态可复核；失效（路径变了）会报 `FLOW_BROKEN @ step N`。

### 并行：端口即实例
`serve.py --port N` 起的实例 = 独立浏览器 + 独立 profile `.user-data/<N>` + 独立端口。并行测试给每个任务
分配不同 `--port`（9222/9223/…），`attach`/`peek`/`flows --port` 用端口寻址，互不串扰（独立 cookie/登录态）。
不同账号并行暂为后续扩展（先 port/profile 隔离同账号）。每实例一份 headed Chromium，按并行度起、别无脑起一堆。

### serve 生命周期：什么时候关
serve 是**会话级共享**的常驻浏览器，**默认留着复用**。这些**不要**关：单个 flow/step 跑完（留终态复核）、
多任务之间（复用省起停）、前端改了代码（Vite HMR 刷新即可）、后端重启后（页面刷新重连）。**才关**（`TaskStop`
对应 serve 任务）：收工不再用、需干净重置（换账号/profile 坏/浏览器崩/端口僵死/升级）、长期闲置回收。
> ⚠ 两层别混：脚本里 `browser.close()` 只断 CDP、**从不杀浏览器**；要真关掉一个实例只能 `TaskStop` 那个 serve 进程。

### 两种模式怎么选
| | 常驻交互（serve + attach）| 一次性（logged_in_page）|
|---|---|---|
| 适合 | 测试主线：到页面→观察/截图→继续/复核；逐步探索；并行隔离 | 纯无人值守断言 / CI；不需要看浏览器、跑完即净 |
| 浏览器 | 常驻、跑完停终态 | 用完即关、无后台残留 |
| 登录态 | `.user-data/<port>` 持久 profile | `storage_state.json` |

## 脚本索引

均以 `python .browser-driving/scripts/<脚本>` 运行（Python 自动把 scripts/ 加进 sys.path）。

| 脚本 | 用途 | 用法 |
|---|---|---|
| `login.py` | 登录并存 `storage_state.json`（幂等刷新） | `python scripts/login.py` |
| `check_auth.py` | 验登录态：`/api/auth/me` 状态码 + 用户 | `python scripts/check_auth.py` |
| `routes.py` | 枚举 Vue Router 真实路由（**别从文件路径猜 URL**） | `python scripts/routes.py` |
| `dump.py` | 页面体检：matched/innerText 长度/canvas 计数/片段（定界空白页 vs 坏页） | `python scripts/dump.py <route\|url>` |
| `screenshot.py` | 导航并截图存 temp-img/ | `python scripts/screenshot.py <route\|url> [名]` |
| `eval.py` | 在某页跑 `page.evaluate`（JS 从文件读，避开 CLI 转义） | `python scripts/eval.py <route\|url> <jsfile>` |
| `serve.py` | **起常驻 headed 浏览器**并 hold（attach 底座），`--port` 即实例 | `run_in_background python scripts/serve.py [--port N]` |
| `peek.py` | 只读快照 + 探测常驻浏览器是否在（连不上非零退出） | `python scripts/peek.py [--port N]` |
| `_common.py` | 核心库（被上面 import，不单独跑） | — |

## `_common.py` helper（写测试脚本时 import）

| 函数 | 作用 |
|---|---|
| `load_config()` | 读 config.json（缺/占位值给可执行报错） |
| `logged_in_page(p)` | **测试脚本统一入口**：返回 `(browser, context, page)` 且已登录（复用 state，无则登录并存） |
| `goto_route(page, route)` | 支持相对路由 `/backtest` 或整 URL；内含 `wait_ready` |
| `wait_ready(page)` | 等 `networkidle`（吞超时） |
| `shot(page, name)` | 截图存 temp-img/，返回路径 |
| `dump_routes(page)` | 取真实路由列表 |
| `is_logged_in` / `login` / `save_state` | 登录态底层操作 |

## 约定（踩坑沉淀，照做省往返）

1. **登录态复用**：`logged_in_page` 自动复用 `storage_state.json`；想强制重登删掉它或跑 `login.py`。
2. **验证优先程序化断言**：⚠ 本环境 Read 图片只上传、不渲染给模型，**肉眼看截图验证不可行**。优先：
   - Playwright `expect(locator)` / `get_by_role` / `get_by_text` 断言可见性与文本；
   - `page.request.get('/api/...')` 直打后端定界前后端（带 cookie，200+数据=bug 在前端）；
   - `page.evaluate("await import('/src/path/mod.ts')")` 动态导入真实源码模块喂真实数据，断言返回值（比重写业务逻辑精确，避免假通过）；
   - 数 `canvas` / `[_echarts_instance_]` 判图是否 init（ECharts v5 实例读不到 DOM，别试图抠 getOption）。
   截图仅用于留证 / 交付给人看。
3. **文件路径 ≠ 路由路径**：首次导航前先 `routes.py`，别从 `views/market/Foo.vue` 猜 `/market/foo`。
4. **空白页先体检再下结论**：`dump.py` 看 `matched` 与 `mainTextLen`——matched=0 是路由没注册；matched 正常但文本短可能数据没回填（已 `wait_ready`，必要时加等目标选择器）。
5. **中文写进 `.py` 源、别从命令行传**：Python 源 UTF-8 直读中文安全；但经 PowerShell 命令行传中文参数会 GBK 损坏。需要中文定位器就写进脚本，不要 `python eval.py ... "中文"`。
6. **后端无热加载**：前端命中新接口 404 时，后端 `nest start` 不带 watch，**重启 server 前先问**，别擅自杀进程。

## 怎么写新测试脚本

```python
# .browser-driving/.tmp/my_test.py（一次性的放 .tmp，会反复用的提到 scripts/ 并登记本表）
import sys, pathlib   # .tmp/ 与 flows/ 是 scripts/ 兄弟目录，需把 scripts/ 加进 sys.path 才能 import _common
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))
from playwright.sync_api import sync_playwright, expect
from _common import logged_in_page, goto_route, shot

with sync_playwright() as p:
    browser, context, page = logged_in_page(p)
    goto_route(page, "/backtest")
    # —— 程序化断言 ——
    resp = context.request.get("http://localhost:3000/api/...")
    assert resp.status == 200, resp.status
    expect(page.get_by_role("button", name="运行")).to_be_visible()
    shot(page, "backtest_loaded.png")  # 留证
    browser.close()
```

> 提到 `scripts/` 的新脚本**回本表登记一行**（名 + 用途 + 用法）。新踩的坑追加 `lessons-learned.md`（Symptom/Cause/Lesson）。
