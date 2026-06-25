"""枚举 Vue Router 真实路由路径（一行一个）。铁律：文件路径 ≠ 路由路径，首次导航前先看这个。
用法: python .browser-driving/scripts/routes.py
"""
from playwright.sync_api import sync_playwright

from _common import logged_in_page, goto_route, dump_routes


def main():
    with sync_playwright() as p:
        browser, context, page = logged_in_page(p)
        goto_route(page, "/")  # 进任意应用页，确保 #app/$router 就绪
        print(dump_routes(page))
        browser.close()


if __name__ == "__main__":
    main()
