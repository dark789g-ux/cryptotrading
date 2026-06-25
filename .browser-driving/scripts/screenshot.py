"""导航到某页并截图存 temp-img/。
用法: python .browser-driving/scripts/screenshot.py <route|url> [文件名]
  例: python .browser-driving/scripts/screenshot.py /backtest backtest.png
注意：本环境 Read 图片不渲染给模型，截图仅留证 / 给人看；验证优先程序化断言。
"""
import sys

from playwright.sync_api import sync_playwright

from _common import logged_in_page, goto_route, shot


def main():
    if len(sys.argv) < 2:
        print("用法: python screenshot.py <route|url> [文件名]")
        sys.exit(2)
    route = sys.argv[1]
    name = sys.argv[2] if len(sys.argv) > 2 else None
    with sync_playwright() as p:
        browser, context, page = logged_in_page(p)
        url = goto_route(page, route)
        dest = shot(page, name)
        print("URL:", url)
        print("SAVED:", dest)
        browser.close()


if __name__ == "__main__":
    main()
