"""页面体检：导航到某页，打印结构性事实，定界「空白页 vs 坏页 vs 数据没回填」。
打印：路由 matched 数、main innerText 长度、canvas / echarts 实例计数、文本片段。
用法: python .browser-driving/scripts/dump.py <route|url>
"""
import sys

from playwright.sync_api import sync_playwright

from _common import logged_in_page, goto_route

PROBE = (
    "(()=>{const a=document.querySelector('#app');"
    "const r=a&&a.__vue_app__&&a.__vue_app__.config.globalProperties.$router;"
    "const m=document.querySelector('main');"
    "const txt=(m&&m.innerText)||'';"
    "return JSON.stringify({"
    "matched:(r&&r.currentRoute&&r.currentRoute.value.matched.length)||0,"
    "path:(r&&r.currentRoute&&r.currentRoute.value.path)||'?',"
    "mainTextLen:txt.length,"
    "canvas:document.querySelectorAll('canvas').length,"
    "echarts:document.querySelectorAll('[_echarts_instance_]').length,"
    "snippet:txt.slice(0,300)"
    "});})()"
)


def main():
    if len(sys.argv) < 2:
        print("用法: python dump.py <route|url>")
        sys.exit(2)
    with sync_playwright() as p:
        browser, context, page = logged_in_page(p)
        url = goto_route(page, sys.argv[1])
        print("URL:", url)
        print(page.evaluate(PROBE))
        browser.close()


if __name__ == "__main__":
    main()
