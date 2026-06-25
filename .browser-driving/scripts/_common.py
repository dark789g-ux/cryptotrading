"""
.browser-driving 核心库 —— 被同目录脚本 import，不单独运行。

运行约定：脚本以 `python .browser-driving/scripts/xxx.py` 跑，Python 会把脚本所在的
scripts/ 目录加进 sys.path，所以同目录脚本直接 `from _common import ...` 即可，无需 path hack。

提供：
  load_config()                 读 config.json（缺/未填给友好报错）
  launch(p)                     按 config 启浏览器（headless 取自 config）
  new_context(browser, ...)     建 context（存在登录态则带上）
  login(context, cfg)           程序化登录（填账号密码），不存 state
  is_logged_in(context)         调 /api/auth/me 判断登录态
  save_state(context)           写 storage_state.json
  logged_in_page(p)             【一次性模式入口】返回 (browser, context, page) 已登录（用完即关，适合纯断言/CI）
  serve(p, port)                【常驻底座】起 headed 持久浏览器+CDP 端口并登录（serve.py 用，需 hold 住进程）
  attach(p, port)               【交互/固化入口】attach 常驻浏览器（close 只断连不杀）；返回 (browser, ctx, page)
  flow_assert(cond, step, ...)  固化流程(flows/)断言，失败统一报 FLOW_BROKEN 便于定位失效
  goto_route(page, route)       支持传相对路由(/backtest) 或整 URL
  wait_ready(page)              等内容到位（networkidle，吞超时）
  shot(page, name)              截图存 temp-img/，返回路径
  dump_routes(page)             取 Vue Router 真实路由列表
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# ---- 路径常量 ---------------------------------------------------------------
SCRIPTS_DIR = Path(__file__).resolve().parent
BD_DIR = SCRIPTS_DIR.parent
CONFIG_PATH = BD_DIR / "config.json"
EXAMPLE_PATH = BD_DIR / "config.example.json"
TEMP_IMG_DIR = BD_DIR / "temp-img"
TMP_DIR = BD_DIR / ".tmp"
AUTH_STATE = BD_DIR / "storage_state.json"
USER_DATA_BASE = BD_DIR / ".user-data"   # 常驻浏览器持久 profile 根（端口即实例：每端口一个子目录）

_PLACEHOLDERS = {"REPLACE_ME", "you@example.com", "", None}


# ---- 配置 -------------------------------------------------------------------
def load_config() -> dict:
    """读 config.json；缺文件或仍是占位值时给可执行的报错提示（不自己编密码）。"""
    if not CONFIG_PATH.exists():
        die(
            f"缺少 config.json。先复制模板并填真实账号密码：\n"
            f"  cp {EXAMPLE_PATH} {CONFIG_PATH}\n"
            f"然后编辑 {CONFIG_PATH} 的 email / password。"
        )
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        die(f"config.json 不是合法 JSON：{e}")
    for key in ("baseUrl", "email", "password"):
        if str(cfg.get(key, "")).strip() in _PLACEHOLDERS:
            die(f"config.json 的 `{key}` 还是占位/空值，请填真实值（账号密码不要我代填）。")
    cfg.setdefault("apiBaseUrl", cfg["baseUrl"].rstrip("/").replace(":5173", ":3000") + "/api")
    cfg.setdefault("rememberMe", True)
    cfg.setdefault("headless", True)
    cfg.setdefault("slowMoMs", 0)
    cfg.setdefault("defaultTimeoutMs", 15000)
    cfg.setdefault("cdpPort", 9222)
    return cfg


def die(msg: str, code: int = 1):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


# ---- 浏览器 / context -------------------------------------------------------
def launch(p, cfg: dict | None = None):
    cfg = cfg or load_config()
    return p.chromium.launch(headless=bool(cfg["headless"]), slow_mo=int(cfg["slowMoMs"]))


def new_context(browser, cfg: dict, use_state: bool = True):
    kwargs = {}
    if use_state and AUTH_STATE.exists():
        kwargs["storage_state"] = str(AUTH_STATE)
    ctx = browser.new_context(**kwargs)
    ctx.set_default_timeout(int(cfg["defaultTimeoutMs"]))
    return ctx


# ---- 登录 -------------------------------------------------------------------
def is_logged_in(context, cfg: dict) -> bool:
    """调 /api/auth/me（带 context 的 cookie）判断登录态。200 = 已登录。"""
    try:
        resp = context.request.get(cfg["apiBaseUrl"].rstrip("/") + "/auth/me")
        return resp.status == 200
    except Exception:
        return False


def login(context, cfg: dict):
    """打开 /login 填账号密码提交。中文定位器写在源文件里（UTF-8 安全）。"""
    page = context.new_page()
    page.goto(cfg["baseUrl"].rstrip("/") + "/login")
    # email：placeholder 是 ASCII，最稳
    page.get_by_placeholder("name@example.com").fill(cfg["email"])
    # password：用 input[type=password]，不依赖中文 label/placeholder
    page.locator('input[type="password"]').fill(cfg["password"])
    if cfg.get("rememberMe"):
        try:
            page.get_by_text("记住我").click()
        except Exception:
            pass
    # 提交 + 等登录接口返回
    with page.expect_response(
        lambda r: "/api/auth/login" in r.url and r.request.method == "POST"
    ) as info:
        page.get_by_role("button", name="登录").click()
    resp = info.value
    if resp.status >= 400:
        body = ""
        try:
            body = resp.text()[:200]
        except Exception:
            pass
        page.close()
        die(f"登录失败 HTTP {resp.status}：{body}（检查 config.json 的账号密码）")
    page.wait_for_url(lambda url: "/login" not in url, timeout=int(cfg["defaultTimeoutMs"]))
    page.close()


def save_state(context):
    context.storage_state(path=str(AUTH_STATE))
    return AUTH_STATE


def logged_in_page(p, cfg: dict | None = None):
    """测试脚本统一入口：返回 (browser, context, page)，保证已登录。

    用法：
        from playwright.sync_api import sync_playwright
        from _common import logged_in_page, goto_route
        with sync_playwright() as p:
            browser, context, page = logged_in_page(p)
            goto_route(page, "/backtest")
            ...
            browser.close()
    """
    cfg = cfg or load_config()
    browser = launch(p, cfg)
    context = new_context(browser, cfg, use_state=True)
    if not is_logged_in(context, cfg):
        login(context, cfg)
        save_state(context)
    page = context.new_page()
    return browser, context, page


# ---- 常驻浏览器底座（CDP attach 交互/固化模式）-------------------------------
def user_data_dir(port: int) -> Path:
    """每个端口一个独立持久 profile 目录（端口即实例标识）。"""
    return USER_DATA_BASE / str(int(port))


def cdp_url(port: int) -> str:
    return f"http://127.0.0.1:{int(port)}"


def serve(p, cfg: dict | None = None, port: int | None = None):
    """起一个常驻 headed 浏览器实例（持久 profile + 开 CDP 端口），保证已登录，返回 persistent context。

    给 serve.py 用：调用方负责 hold 住进程让浏览器常驻；进程退出（TaskStop/kill）时浏览器随之关闭。
    端口即实例：不同 port → 不同 profile + 不同浏览器 + 不同 CDP 端口，互不串扰。
    """
    cfg = cfg or load_config()
    port = int(port or cfg["cdpPort"])
    udd = user_data_dir(port)
    udd.mkdir(parents=True, exist_ok=True)
    ctx = p.chromium.launch_persistent_context(
        str(udd),
        headless=False,
        slow_mo=int(cfg["slowMoMs"]),
        args=[f"--remote-debugging-port={port}"],
    )
    ctx.set_default_timeout(int(cfg["defaultTimeoutMs"]))
    if not is_logged_in(ctx, cfg):
        login(ctx, cfg)            # 登录态落进持久 profile，后续 attach/重起免登录
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(cfg["baseUrl"].rstrip("/") + "/")
    wait_ready(page)
    return ctx


def attach(p, cfg: dict | None = None, port: int | None = None):
    """attach 到 serve 起的常驻浏览器实例（端口寻址）。返回 (browser, context, page)。

    探索/固化/peek 的统一入口。复用当前 context 的现有页面（pages[0]），保留 serve/上一步留下的状态。
    ⚠ browser.close() 只断开 CDP 连接、**不杀常驻浏览器**（已核实）——脚本退出后浏览器停在终态。
    """
    cfg = cfg or load_config()
    port = int(port or cfg["cdpPort"])
    browser = p.chromium.connect_over_cdp(cdp_url(port))
    ctx = browser.contexts[0]
    ctx.set_default_timeout(int(cfg["defaultTimeoutMs"]))
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    return browser, ctx, page


def flow_assert(cond: bool, step, expect, actual):
    """固化流程(flows/)关键步骤断言。失败统一报 FLOW_BROKEN，一眼定位是哪个路径假设破了。"""
    if not cond:
        die(
            f"FLOW_BROKEN @ step {step}: 期望 {expect!r} 实际 {actual!r}"
            f" → 路径可能变了，回交互探索重摸并更新该 flow 文件头部的『上次验证/关键路径假设』"
        )


# ---- 页面操作 ---------------------------------------------------------------
def goto_route(page, route: str, cfg: dict | None = None):
    """route 可以是相对路由(/backtest)或整 URL(http://...)。"""
    cfg = cfg or load_config()
    if route.startswith("http://") or route.startswith("https://"):
        url = route
    else:
        url = cfg["baseUrl"].rstrip("/") + "/" + route.lstrip("/")
    page.goto(url)
    wait_ready(page)
    return url


def wait_ready(page):
    """等异步数据到位（lessons：navigate 后空白常是数据没回填，不是坏页）。吞超时不抛。"""
    try:
        page.wait_for_load_state("networkidle", timeout=8000)
    except Exception:
        pass


def shot(page, name: str | None = None, full_page: bool = True) -> Path:
    """截图存 temp-img/。注意本环境 Read 图片不渲染给模型，截图仅留证；验证优先程序化断言。"""
    TEMP_IMG_DIR.mkdir(parents=True, exist_ok=True)
    if not name:
        name = "shot"
    if not name.lower().endswith((".png", ".jpg", ".jpeg")):
        name += ".png"
    dest = TEMP_IMG_DIR / name
    page.screenshot(path=str(dest), full_page=full_page)
    return dest


def dump_routes(page) -> str:
    """取 Vue Router 真实路由路径（一行一个）。文件路径 ≠ 路由路径，首次导航前先看这个。"""
    js = (
        "(()=>{const a=document.querySelector('#app');"
        "const r=a&&a.__vue_app__&&a.__vue_app__.config.globalProperties.$router;"
        "if(!r)return 'NO_ROUTER';"
        "return r.getRoutes().map(x=>x.path).filter(Boolean).sort().join(String.fromCharCode(10));})()"
    )
    return page.evaluate(js)
