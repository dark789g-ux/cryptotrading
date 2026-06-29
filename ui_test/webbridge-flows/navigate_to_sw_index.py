# 目标：登录后从首页进入申万指数界面，验证表格加载成功
# 上次验证：2026-06-28
# 关键路径假设：
#   - 页面路径 /symbols
#   - A 股数据 tab 可通过文本 "A 股数据" 定位
#   - A 股指数子 tab 可通过文本 "A 股指数" 定位
#   - 申万指数子 tab 可通过文本 "申万指数" 定位
#   - 申万指数表格加载后 tbody 至少有 1 行

import argparse
import json
import sys
import time
from pathlib import Path

# 优先用 requests；没装则回退到 urllib.request
try:
    import requests
except ImportError:
    import urllib.request
    requests = None  # type: ignore

# 读取测试配置（脚本位于 ui_test/webbridge-flows/，配置在 ui_test/ 下）
CONFIG_PATH = Path(__file__).resolve().parents[1] / "test_config.json"
if not CONFIG_PATH.exists():
    print("ERROR: ui_test/test_config.json 不存在，请从 test_config.example.json 复制并填写")
    sys.exit(1)

CONFIG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
WEBBRIDGE_URL = CONFIG.get("webbridge_url", "http://127.0.0.1:10086/command")
BASE_URL = CONFIG.get("base_url", "http://localhost:5173")
API_BASE_URL = CONFIG.get("api_base_url", "http://localhost:3000/api")


def send_wb(action: str, args: dict | None = None, session: str | None = None) -> dict:
    """发送 WebBridge 命令并返回 JSON 结果。"""
    session = session or CONFIG.get("default_session", "default")
    payload = {"action": action, "args": args or {}, "session": session}

    if requests is not None:
        resp = requests.post(WEBBRIDGE_URL, json=payload, timeout=60)
        resp.raise_for_status()
        return resp.json()

    # 标准库回退
    req = urllib.request.Request(
        WEBBRIDGE_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def assert_flow(condition: bool, step: int, expect: str, actual: str, session: str | None = None) -> None:
    """断言失败时打印 FLOW_BROKEN，清理 session 并退出。"""
    if not condition:
        print(f"FLOW_BROKEN @ step {step}: 期望 {expect} 实际 {actual}")
        # 失败时清理浏览器标签，避免残留
        try:
            send_wb("close_session", {}, session=session)
        except Exception:
            pass
        sys.exit(1)


def ensure_login(session: str, base_url: str) -> None:
    """如果当前浏览器会话未登录，先导航到首页再用 test_config.json 里的账号密码登录。"""
    auth = CONFIG.get("auth", {})
    email = auth.get("email")
    password = auth.get("password")
    if not email or not password:
        print("ERROR: test_config.json 中 auth.email / auth.password 为空")
        sys.exit(1)

    # 先导航到一个页面，确保 session 有 tab 才能 evaluate
    send_wb(
        "navigate",
        {"url": f"{base_url}/backtest", "newTab": True},
        session=session,
    )

    # 检查是否已登录
    me = send_wb(
        "evaluate",
        {"code": f"fetch('{API_BASE_URL}/auth/me', {{credentials:'include'}}).then(r=>r.status)"},
        session=session,
    )
    if me.get("data", {}).get("value") == 200:
        return

    # 登录：用 JSON.stringify 在浏览器端构造 body，避免 Python/JS 字符串转义问题
    login_code = f"""
    fetch('{API_BASE_URL}/auth/login', {{
        method: 'POST',
        headers: {{'Content-Type': 'application/json'}},
        body: JSON.stringify({{email: {json.dumps(email)}, password: {json.dumps(password)}}}),
        credentials: 'include'
    }}).then(r => r.json()).then(j => JSON.stringify(j))
    """
    login = send_wb("evaluate", {"code": login_code}, session=session)
    login_value = login.get("data", {}).get("value", "")
    if '"error"' in login_value.lower() or '"invalid"' in login_value.lower() or '"message"' in login_value.lower():
        print(f"ERROR: 登录失败: {login_value}")
        sys.exit(1)


def send_screenshot(path: str | None = None, session: str | None = None) -> dict:
    """截图并保存到 ui_test/.tmp/；未指定路径则用带时间戳的文件名。"""
    if path is None:
        from datetime import datetime
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        tmp_dir = Path(__file__).resolve().parents[2] / ".tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        path = str(tmp_dir / f"flow-screenshot-{ts}.png")
    return send_wb("screenshot", {"format": "png", "path": path}, session=session)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=BASE_URL)
    parser.add_argument("--session", default=CONFIG.get("default_session", "navigate-sw-index"))
    args = parser.parse_args()

    session = args.session

    # ===== Step 0: 确保登录 =====
    ensure_login(session, args.base_url)

    # ===== Step 1: 打开 /symbols 页面 =====
    nav = send_wb(
        "navigate",
        {"url": f"{args.base_url}/symbols", "newTab": True, "group_title": "申万指数测试"},
        session=session,
    )
    assert_flow(
        nav.get("ok") and nav.get("data", {}).get("success"),
        step=1,
        expect="导航到 /symbols 成功",
        actual=str(nav),
        session=session,
    )

    # 等待页面挂载
    time.sleep(1)

    # ===== Step 2: 点击 "A 股数据" tab =====
    click_a_shares = send_wb(
        "evaluate",
        {
            "code": """
            (() => {
                const tabs = Array.from(document.querySelectorAll('.symbol-tabs__tab'));
                const target = tabs.find(t => t.innerText.includes('A 股数据'));
                if (target) { target.click(); return 'clicked: ' + target.innerText.trim(); }
                return 'not found';
            })()
            """
        },
        session=session,
    )
    assert_flow(
        "clicked" in (click_a_shares.get("data", {}).get("value") or ""),
        step=2,
        expect="点击 A 股数据 tab 成功",
        actual=click_a_shares.get("data", {}).get("value"),
        session=session,
    )
    time.sleep(0.5)

    # ===== Step 3: 点击 "A 股指数" tab =====
    click_index = send_wb(
        "evaluate",
        {
            "code": """
            (() => {
                const tabs = Array.from(document.querySelectorAll('.n-tabs-tab'));
                const target = tabs.find(t => t.innerText.includes('A 股指数'));
                if (target) { target.click(); return 'clicked: ' + target.innerText.trim(); }
                return 'not found';
            })()
            """
        },
        session=session,
    )
    assert_flow(
        "clicked" in (click_index.get("data", {}).get("value") or ""),
        step=3,
        expect="点击 A 股指数 tab 成功",
        actual=click_index.get("data", {}).get("value"),
        session=session,
    )
    time.sleep(0.5)

    # ===== Step 4: 点击 "申万指数" tab =====
    click_sw = send_wb(
        "evaluate",
        {
            "code": """
            (() => {
                const tabs = Array.from(document.querySelectorAll('.n-tabs-tab'));
                const target = tabs.find(t => t.innerText.includes('申万指数'));
                if (target) { target.click(); return 'clicked: ' + target.innerText.trim(); }
                return 'not found';
            })()
            """
        },
        session=session,
    )
    assert_flow(
        "clicked" in (click_sw.get("data", {}).get("value") or ""),
        step=4,
        expect="点击申万指数 tab 成功",
        actual=click_sw.get("data", {}).get("value"),
        session=session,
    )

    # 等待表格加载：轮询最多 10 秒
    for _ in range(20):
        verify = send_wb(
            "evaluate",
            {
                "code": """
                (() => {
                    return JSON.stringify({
                        hasTable: document.querySelector('table') !== null,
                        rowCount: document.querySelectorAll('table tbody tr').length
                    });
                })()
                """
            },
            session=session,
        )
        verify_value = json.loads(verify.get("data", {}).get("value", "{}"))
        if verify_value.get("hasTable") and verify_value.get("rowCount", 0) > 0:
            break
        time.sleep(0.5)

    # ===== Step 5: 验证申万指数界面加载 =====
    verify = send_wb(
        "evaluate",
        {
            "code": """
            (() => {
                const bodyText = document.body.innerText;
                return JSON.stringify({
                    url: window.location.href,
                    pathname: window.location.pathname,
                    title: document.title,
                    hasSw: bodyText.includes('申万'),
                    hasIndex: bodyText.includes('指数'),
                    hasSwIndex: bodyText.includes('申万指数'),
                    hasTable: document.querySelector('table') !== null,
                    rowCount: document.querySelectorAll('table tbody tr').length
                });
            })()
            """
        },
        session=session,
    )
    verify_value = json.loads(verify.get("data", {}).get("value", "{}"))
    assert_flow(
        verify_value.get("pathname") == "/symbols",
        step=5,
        expect="URL 路径为 /symbols",
        actual=verify_value.get("pathname"),
        session=session,
    )
    assert_flow(
        verify_value.get("hasSwIndex") is True,
        step=6,
        expect="页面包含 '申万指数' 文本",
        actual=str(verify_value.get("hasSwIndex")),
        session=session,
    )
    assert_flow(
        verify_value.get("hasTable") is True and verify_value.get("rowCount", 0) > 0,
        step=7,
        expect="申万指数表格已加载且至少有一行数据",
        actual=f"hasTable={verify_value.get('hasTable')}, rowCount={verify_value.get('rowCount')}",
        session=session,
    )

    # ===== Step 8: 截图留证 =====
    shot = send_screenshot(session=session)

    # ===== 收尾 =====
    # 如需关闭 session 清理标签，取消下行注释：
    # send_wb("close_session", {}, session=session)

    print(f"FLOW_OK: 申万指数界面加载成功，截图保存在 {shot.get('data', {}).get('path')}")


if __name__ == "__main__":
    main()
