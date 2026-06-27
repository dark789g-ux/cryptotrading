"""流程：验证 活跃市值(0AMV)面板 KlineChartToolbar 显示 symbol code + name
上次验证：2026-06-27 通过（分支 feat/table-column-prefs-generalization）
关键路径假设：
  - 路由 /symbols → 活跃市值 tab
  - 活跃市值面板直接嵌入 KlineChart（非 FlowTrendModal，无表格行）
  - 选择器：`.kline-toolbar__symbol-code` / `.kline-toolbar__symbol-name`
  - 默认显示 930903.CSI / 中证A股指数
跑法：
  1) 先起常驻浏览器（后台）：run_in_background python .browser-driving/scripts/serve.py [--port N]
  2) 一步到位重放：python .browser-driving/flows/kline-toolbar-active-mv.py [--port N]
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
            # —— step 1: 导航到 Symbols 页面 ——
            goto_route(page, "/symbols")
            flow_assert(page.url.endswith("/symbols"), 1, "url 落在 /symbols", page.url)

            # —— step 2: 切换到活跃市值 tab ——
            page.click("text=活跃市值", timeout=5000)
            page.wait_for_timeout(3000)

            # —— step 3: 等待 KlineChart 渲染 ——
            page.wait_for_selector(".kline-toolbar", timeout=15000)
            has_toolbar = page.locator(".kline-toolbar").count() > 0
            flow_assert(has_toolbar, 3, "活跃市值面板存在 kline-toolbar", has_toolbar)

            # —— step 4: 验证 code 和 name 都存在 ——
            code_el = page.locator(".kline-toolbar__symbol-code")
            name_el = page.locator(".kline-toolbar__symbol-name")

            has_code = code_el.count() > 0
            has_name = name_el.count() > 0
            code_text = code_el.inner_text() if has_code else None
            name_text = name_el.inner_text() if has_name else None

            flow_assert(has_code, 4, "toolbar 显示 symbol code", f"has_code={has_code}, text={code_text}")
            flow_assert(has_name, 4, "toolbar 显示 symbol name", f"has_name={has_name}, text={name_text}")
            flow_assert(code_text and len(code_text) > 0, 4, "symbol code 非空", code_text)
            flow_assert(name_text and len(name_text) > 0, 4, "symbol name 非空", name_text)

            print(f"ACTIVE_MV: code={code_text}, name={name_text}")
            shot(page, "scene3_active_mv_toolbar.png")

            print("FLOW_OK Active MV panel toolbar shows code + name")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
