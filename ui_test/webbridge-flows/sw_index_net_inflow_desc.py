# 目标：登录后进入申万指数界面，筛选三级行业，按 10日净流入 降序排列，验证排序结果正确
# 上次验证：2026-06-28
# 关键路径假设：
#   - 页面路径 /symbols
#   - A 股数据 tab 可通过文本 "A 股数据" 定位
#   - A 股指数子 tab 可通过文本 "A 股指数" 定位
#   - 申万指数子 tab 可通过文本 "申万指数" 定位
#   - 三级筛选通过 label 文本 "三级" 点击
#   - 10日净流入列在申万指数表格（document.querySelectorAll('table')[2]）的第 8 列（index 7）
#   - Naive UI n-data-table 排序循环：无排序 → 点击 1 次 → 降序（descend）→ 点击 2 次 → 升序（ascend）→ 点击 3 次 → 无排序
#   - 倒序（降序）需点击 1 次 sorter
#   - 三级申万指数代码格式为 85xxxx.SI 或 857xxx.SI 等

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


def parse_net_inflow(text: str) -> float:
    """将 '55.06 亿' / '97462.25 万' / '-11924.89 万' 等文本解析为以'元'为单位的浮点数。"""
    text = text.strip()
    # 提取数值部分
    num_str = ""
    sign = 1
    for ch in text:
        if ch == "-":
            sign = -1
        elif ch.isdigit() or ch == ".":
            num_str += ch
    if not num_str:
        return 0.0
    value = float(num_str) * sign
    # 根据单位转换
    if "亿" in text:
        return value * 100_000_000
    elif "万" in text:
        return value * 10_000
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=BASE_URL)
    parser.add_argument("--session", default=CONFIG.get("default_session", "sw-index-net-inflow-desc"))
    args = parser.parse_args()

    session = args.session

    # ===== Step 0: 确保登录 =====
    ensure_login(session, args.base_url)

    # ===== Step 1: 打开 /symbols 页面 =====
    nav = send_wb(
        "navigate",
        {"url": f"{args.base_url}/symbols", "newTab": True, "group_title": "申万指数排序测试"},
        session=session,
    )
    assert_flow(
        nav.get("ok") and nav.get("data", {}).get("success"),
        step=1,
        expect="导航到 /symbols 成功",
        actual=str(nav),
        session=session,
    )
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
    time.sleep(2)

    # ===== Step 5: 点击 "三级" 筛选 =====
    click_level3 = send_wb(
        "evaluate",
        {
            "code": """
            (() => {
                const labels = Array.from(document.querySelectorAll('label'));
                const target = labels.find(l => l.innerText.trim() === '三级');
                if (target) { target.click(); return 'clicked: ' + target.innerText.trim(); }
                return 'not found';
            })()
            """
        },
        session=session,
    )
    assert_flow(
        "clicked" in (click_level3.get("data", {}).get("value") or ""),
        step=5,
        expect="点击三级筛选成功",
        actual=click_level3.get("data", {}).get("value"),
        session=session,
    )
    time.sleep(2)

    # 轮询确认三级数据已加载
    level3_loaded = False
    for _ in range(10):
        verify = send_wb(
            "evaluate",
            {
                "code": """
                (() => {
                    const table = document.querySelector('[data-testid="a-shares-index-sw-table"]');
                    if (!table) return JSON.stringify({error: 'table not found'});
                    const rows = Array.from(table.querySelectorAll('tbody tr')).slice(0, 3);
                    const codes = rows.map(tr => {
                        const tds = tr.querySelectorAll('td');
                        return tds[0]?.innerText?.trim() || '';
                    });
                    const isLevel3 = codes.every(c => c.startsWith('85'));
                    return JSON.stringify({codes, isLevel3});
                })()
                """
            },
            session=session,
        )
        verify_value = json.loads(verify.get("data", {}).get("value", "{}"))
        if verify_value.get("isLevel3"):
            level3_loaded = True
            break
        time.sleep(0.5)

    assert_flow(
        level3_loaded,
        step=5,
        expect="三级申万指数数据已加载",
        actual=str(verify_value),
        session=session,
    )

    # ===== Step 6: 点击 "10日净流入" 排序按钮（1 次 = 降序） =====
    click_sort = send_wb(
        "evaluate",
        {
            "code": """
            (() => {
                const table = document.querySelector('[data-testid="a-shares-index-sw-table"]');
                if (!table) return 'table not found';
                const headers = Array.from(table.querySelectorAll('thead th'));
                const targetTh = headers.find(th => th.innerText.includes('10日净流入'));
                if (!targetTh) return 'header not found';
                const sorter = targetTh.querySelector('.n-data-table-sorter');
                if (!sorter) return 'sorter not found';
                sorter.click();
                return 'clicked sorter';
            })()
            """
        },
        session=session,
    )
    assert_flow(
        "clicked" in (click_sort.get("data", {}).get("value") or ""),
        step=6,
        expect="点击 10日净流入 排序按钮成功",
        actual=click_sort.get("data", {}).get("value"),
        session=session,
    )
    time.sleep(2)

    # ===== Step 7: 验证排序结果 =====
    verify = send_wb(
        "evaluate",
        {
            "code": """
            (() => {
                const table = document.querySelector('[data-testid="a-shares-index-sw-table"]');
                if (!table) return JSON.stringify({error: 'table not found'});
                const headers = Array.from(table.querySelectorAll('thead th'));
                const targetTh = headers.find(th => th.innerText.includes('10日净流入'));
                const thClass = targetTh?.className || '';

                const rows = Array.from(table.querySelectorAll('tbody tr'));
                const values = rows.map(tr => {
                    const tds = tr.querySelectorAll('td');
                    return {
                        code: tds[0]?.innerText?.trim() || '',
                        name: tds[1]?.innerText?.trim() || '',
                        net10: tds[7]?.innerText?.trim() || ''
                    };
                });

                return JSON.stringify({
                    url: window.location.href,
                    pathname: window.location.pathname,
                    thClass,
                    rowCount: rows.length,
                    values
                });
            })()
            """
        },
        session=session,
    )
    verify_value = json.loads(verify.get("data", {}).get("value", "{}"))

    # 验证页面路径
    assert_flow(
        verify_value.get("pathname") == "/symbols",
        step=7,
        expect="URL 路径为 /symbols",
        actual=verify_value.get("pathname"),
        session=session,
    )

    # 验证表格有数据
    row_count = verify_value.get("rowCount", 0)
    assert_flow(
        row_count > 0,
        step=8,
        expect="申万指数表格有数据",
        actual=f"rowCount={row_count}",
        session=session,
    )

    # 验证是三级申万指数
    values = verify_value.get("values", [])
    all_level3 = all(v.get("code", "").startswith("85") for v in values)
    assert_flow(
        all_level3,
        step=9,
        expect="所有行都是三级申万指数（代码以 85 开头）",
        actual=f"非三级行: {[v['code'] for v in values if not v['code'].startswith('85')]}",
        session=session,
    )

    # 验证排序状态（表头有 --sorting 类名）
    th_class = verify_value.get("thClass", "")
    assert_flow(
        "n-data-table-th--sorting" in th_class,
        step=10,
        expect="10日净流入列处于排序状态",
        actual=th_class,
        session=session,
    )

    # 验证前 N 行是降序（从大到小）
    # 由于前端格式化可能混合"亿"和"万"单位，我们用 parse_net_inflow 统一转换为元
    net_values = [parse_net_inflow(v.get("net10", "")) for v in values]
    # 过滤掉 0 值（可能是解析失败的）
    valid_values = [v for v in net_values if v != 0]

    # 检查前 5 个有效值是否降序
    check_count = min(5, len(valid_values))
    is_descending = all(valid_values[i] >= valid_values[i + 1] for i in range(check_count - 1))
    assert_flow(
        is_descending,
        step=11,
        expect=f"前 {check_count} 行 10日净流入 为降序",
        actual=f"values={valid_values[:check_count]}",
        session=session,
    )

    # ===== Step 12: 截图留证 =====
    shot = send_screenshot(session=session)

    # ===== 收尾 =====
    # 如需关闭 session 清理标签，取消下行注释：
    # send_wb("close_session", {}, session=session)

    print(f"FLOW_OK: 三级申万指数按 10日净流入 降序排列验证通过，截图保存在 {shot.get('data', {}).get('path')}")


if __name__ == "__main__":
    main()
