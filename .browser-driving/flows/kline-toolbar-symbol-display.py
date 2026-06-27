"""流程：验证 A 股个股详情面板 KlineChartToolbar 显示 symbol code + name
上次验证：2026-06-27 通过（分支 feat/table-column-prefs-generalization）
关键路径假设（这些变了脚本会断 → 回交互探索重摸、修好后更新本文件头部）：
  - 路由 /symbols
  - naive-ui tabs 用 [role=tab] 而非 .n-tabs-tab（Playwright  locator 差异）
  - 切换 A 股 tab 后需先切分栏视图（split）再点行，否则 detail panel 不渲染
  - 选择器：`.kline-toolbar__symbol-code` / `.kline-toolbar__symbol-name`
  - 接口：A 股列表 API 返回数据（有 table rows）
跑法：
  1) 先起常驻浏览器（后台）：run_in_background python .browser-driving/scripts/serve.py [--port N]
  2) 一步到位重放：python .browser-driving/flows/kline-toolbar-symbol-display.py [--port N]
说明：跑完只断开 CDP、浏览器停终态不关，便于肉眼复核 / 继续操作。
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
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(2000)
            flow_assert(page.url.endswith("/symbols"), 1, "url 落在 /symbols", page.url)

            # —— step 2: 切换到 A 股数据 tab ——
            page.click("text=A 股数据", timeout=5000)
            page.wait_for_timeout(500)

            # —— step 3: 等待表格数据加载 ——
            page.wait_for_selector("table tbody tr", timeout=10000)

            # —— step 4: 切换到分栏视图（split view）——
            header_buttons = page.locator("header button, .panel-header button, .header-left button").all()
            flow_assert(len(header_buttons) >= 2, 4, "header 至少有 2 个按钮", len(header_buttons))
            header_buttons[1].click()
            page.wait_for_timeout(1000)

            # —— step 4: 点击第一行打开详情面板 ——
            # 先尝试直接点击行；若 toolbar 未出现，再切 split view 重试
            #（reload 后 split view 状态可能不一致，需兼容两种状态）
            page.locator("table tbody tr").first.click()
            page.wait_for_timeout(2500)

            if page.locator(".kline-toolbar").count() == 0:
                # 直接点击未打开 detail panel，尝试切 split view 再点
                header_buttons = page.locator("header button, .panel-header button, .header-left button").all()
                if len(header_buttons) >= 2:
                    header_buttons[1].click()
                    page.wait_for_timeout(1000)
                    page.locator("table tbody tr").first.click()
                    page.wait_for_timeout(2500)

            # —— step 5: 验证 toolbar 显示 symbol code + name ——
            has_toolbar = page.locator(".kline-toolbar").count() > 0
            flow_assert(has_toolbar, 5, "kline-toolbar 出现在 DOM 中", has_toolbar)

            code_el = page.locator(".kline-toolbar__symbol-code")
            name_el = page.locator(".kline-toolbar__symbol-name")
            has_code = code_el.count() > 0
            has_name = name_el.count() > 0
            code_text = code_el.inner_text() if has_code else None
            name_text = name_el.inner_text() if has_name else None

            flow_assert(has_code, 6, "toolbar 显示 symbol code", f"has_code={has_code}, text={code_text}")
            flow_assert(has_name, 6, "toolbar 显示 symbol name", f"has_name={has_name}, text={name_text}")
            flow_assert(code_text and len(code_text) > 0, 6, "symbol code 非空", code_text)
            flow_assert(name_text and len(name_text) > 0, 6, "symbol name 非空", name_text)

            print(f"SYMBOL_1: code={code_text}, name={name_text}")
            shot(page, "scene1_first_symbol_toolbar.png")

            # —— step 7: 点击第二行验证 reactive 更新 ——
            page.locator("table tbody tr").nth(1).click()
            page.wait_for_timeout(1500)
            code_text2 = code_el.inner_text() if code_el.count() > 0 else None
            name_text2 = name_el.inner_text() if name_el.count() > 0 else None

            flow_assert(code_text2 != code_text, 7, "切换股票后 code 变化", f"old={code_text}, new={code_text2}")
            flow_assert(name_text2 != name_text, 7, "切换股票后 name 变化", f"old={name_text}, new={name_text2}")

            print(f"SYMBOL_2: code={code_text2}, name={name_text2}")
            shot(page, "scene1_second_symbol_toolbar.png")

            print(f"FLOW_OK A-share detail panel symbol display verified")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
