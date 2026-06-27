"""流程：验证 Watchlists 页面 KlineChartToolbar 仅显示 symbol code（无 name）
上次验证：2026-06-27 通过（分支 feat/table-column-prefs-generalization）
关键路径假设：
  - 路由 /watchlists
  - 选择器：`.kline-toolbar__symbol-code` / `.kline-toolbar__symbol-name`
  - Watchlists 页面使用 KlineChartToolbar 时 symbolName 为空字符串
  - 需先打开 K 线抽屉（点击表格行或查看图表按钮）才能看到 toolbar
跑法：
  1) 先起常驻浏览器（后台）：run_in_background python .browser-driving/scripts/serve.py [--port N]
  2) 一步到位重放：python .browser-driving/flows/kline-toolbar-watchlists-code-only.py [--port N]
"""
import argparse
import sys
import pathlib

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
            # —— step 1: 导航到 Watchlists 页面 ——
            goto_route(page, "/watchlists")
            flow_assert(page.url.endswith("/watchlists"), 1, "url 落在 /watchlists", page.url)

            # —— step 2: 等待页面加载（表格或空状态）——
            page.wait_for_timeout(1500)

            # —— step 3: 检查是否有 KlineChartToolbar ——
            # Watchlists 页面可能有多个列表，每个列表项可能有 KlineChart
            # 先检查是否有任何 toolbar
            has_any_toolbar = page.locator(".kline-toolbar").count() > 0

            if not has_any_toolbar:
                # 可能没有展开详情或没有数据，尝试点击第一行或"查看K线"按钮
                rows = page.locator("table tbody tr, .watchlist-item, [class*='watchlist'] tr").count()
                if rows > 0:
                    # 先尝试点击第一行
                    page.locator("table tbody tr, .watchlist-item, [class*='watchlist'] tr").first.click()
                    page.wait_for_timeout(1000)
                    has_any_toolbar = page.locator(".kline-toolbar").count() > 0
                    # 如果还没打开，尝试点击"查看K线"按钮
                    if not has_any_toolbar:
                        view_chart_btn = page.locator("button:has-text('查看K线'), [aria-label='查看K线']").first
                        if view_chart_btn.count() > 0:
                            view_chart_btn.click()
                            page.wait_for_timeout(1500)
                            has_any_toolbar = page.locator(".kline-toolbar").count() > 0

            flow_assert(has_any_toolbar, 3, "页面存在 kline-toolbar", has_any_toolbar)

            # —— step 4: 验证 code 存在但 name 不存在 ——
            code_els = page.locator(".kline-toolbar__symbol-code")
            name_els = page.locator(".kline-toolbar__symbol-name")

            has_code = code_els.count() > 0
            has_name = name_els.count() > 0

            flow_assert(has_code, 4, "toolbar 显示 symbol code", f"has_code={has_code}")
            flow_assert(not has_name, 4, "toolbar 不显示 symbol name（Watchlists 场景）", f"has_name={has_name}")

            print(f"WATCHLISTS_TOOLBAR: has_code={has_code}, has_name={has_name}")
            shot(page, "scene2_watchlists_toolbar.png")

            print("FLOW_OK Watchlists toolbar shows code only, no name")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
