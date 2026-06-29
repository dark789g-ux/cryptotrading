# 目标：一句话说明测什么
# 上次验证：YYYY-MM-DD
# 关键路径假设：
#   - 前端 dev 服务器在 http://localhost:5173
#   - 页面路径 /backtest
#   - 运行按钮有 data-testid="run-backtest"
#   - 点击后调用 POST /api/backtest/run

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
    """如果当前浏览器会话未登录，先导航到页面再用 test_config.json 里的账号密码登录。"""
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
    parser.add_argument("--session", default=CONFIG.get("default_session", "backtest-run-button"))
    args = parser.parse_args()

    session = args.session

    # 如目标页需要登录，先确保登录态
    # ensure_login(session, args.base_url)

    # ===== Step 1: 打开目标页面 =====
    nav = send_wb(
        "navigate",
        {"url": f"{args.base_url}/backtest", "newTab": True, "group_title": "回测页测试"},
        session=session,
    )
    assert_flow(
        nav.get("ok") and nav.get("data", {}).get("success"),
        step=1,
        expect="导航成功",
        actual=str(nav),
        session=session,
    )

    # 等待页面挂载：轮询检查标题，最多 10 秒
    for _ in range(20):
        title = send_wb("evaluate", {"code": "document.title"}, session=session)
        if "回测" in (title.get("data", {}).get("value") or ""):
            break
        time.sleep(0.5)
    assert_flow(
        "回测" in (title.get("data", {}).get("value") or ""),
        step=2,
        expect="页面标题包含'回测'",
        actual=title.get("data", {}).get("value"),
        session=session,
    )

    # ===== Step 3: 点击运行按钮（用稳定选择器，别用 @e ref） =====
    click = send_wb(
        "click",
        {"selector": "[data-testid='run-backtest']"},
        session=session,
    )
    assert_flow(
        click.get("ok") and click.get("data", {}).get("success"),
        step=3,
        expect="点击运行按钮成功",
        actual=str(click),
        session=session,
    )

    # 等待结果渲染
    for _ in range(20):
        result = send_wb(
            "evaluate",
            {"code": "document.querySelector('[data-testid=\"backtest-result\"]')?.innerText ?? 'NOT_FOUND'"},
            session=session,
        )
        if result.get("data", {}).get("value") != "NOT_FOUND":
            break
        time.sleep(0.5)

    assert_flow(
        result.get("data", {}).get("value") != "NOT_FOUND",
        step=4,
        expect="结果区域已渲染",
        actual=result.get("data", {}).get("value"),
        session=session,
    )

    # ===== Step 5: 验证网络请求（需先 start network）=====
    # send_wb("network", {"cmd": "start"}, session=session)
    # send_wb("click", {"selector": "[data-testid='run-backtest']"}, session=session)
    # time.sleep(1)
    # net = send_wb("network", {"cmd": "list", "filter": "/api/backtest/run"}, session=session)
    # requests_list = net.get("data", {}).get("requests", [])
    # assert_flow(
    #     len(requests_list) > 0,
    #     step=5,
    #     expect="触发 POST /api/backtest/run",
    #     actual="未抓到请求",
    #     session=session,
    # )

    # ===== Step 6: 截图留证 =====
    shot = send_screenshot(session=session)

    # ===== 收尾 =====
    # 如需关闭 session 清理标签，取消下行注释：
    # send_wb("close_session", {}, session=session)

    print(f"FLOW_OK: 回测页运行按钮流程通过，截图保存在 {shot.get('data', {}).get('path')}")


if __name__ == "__main__":
    main()
