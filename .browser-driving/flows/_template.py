"""流程：<一句话描述这条流程在验什么>
上次验证：YYYY-MM-DD 通过（分支/commit）
关键路径假设（这些变了脚本会断 → 回交互探索重摸、修好后更新本文件头部）：
  - 路由 /xxx
  - 选择器：按钮「同步」get_by_role("button", name="同步")
  - 接口 POST /api/xxx 期望 200
跑法：
  1) 先起常驻浏览器（后台）：run_in_background python .browser-driving/scripts/serve.py [--port N]
  2) 一步到位重放：python .browser-driving/flows/<本文件> [--port N]
说明：跑完只断开 CDP、浏览器停在终态不关，便于肉眼复核 / 继续操作。
"""
import argparse
import sys
import pathlib

# flows/ 是 scripts/ 的兄弟目录，把 scripts/ 加进 sys.path 才能 import _common
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))

from playwright.sync_api import sync_playwright

from _common import load_config, attach, goto_route, flow_assert, shot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None, help="连哪个常驻实例（默认 config.cdpPort=9222）")
    args = ap.parse_args()

    cfg = load_config()
    port = int(args.port or cfg["cdpPort"])

    with sync_playwright() as p:
        browser, ctx, page = attach(p, cfg, port=port)
        try:
            # —— 自己回到起点，保证可重放幂等（别依赖浏览器当前停在哪）——
            goto_route(page, "/backtest")
            flow_assert(page.url.endswith("/backtest"), 1, "url 落在 /backtest", page.url)

            # —— step 2：示例断言（按真实流程替换）——
            rows = page.evaluate("()=>document.querySelectorAll('table tbody tr').length")
            flow_assert(rows > 0, 2, ">0 行", rows)

            # —— 留证 ——
            shot(page, "flow_template.png")
            print(f"FLOW_OK rows={rows} url={page.url}")
        finally:
            browser.close()   # 只断开 CDP，浏览器停终态不关


if __name__ == "__main__":
    main()
