"""在某页跑一段 page.evaluate(JS)。JS 从【文件】读，避免命令行传 JS 的转义/中文 GBK 坑。
用法: python .browser-driving/scripts/eval.py <route|url> <jsfile>
  例: 先把 JS 写到 .browser-driving/.tmp/probe.js，再
      python .browser-driving/scripts/eval.py /backtest .browser-driving/.tmp/probe.js
JS 形如一个表达式或 IIFE，返回值会被打印（建议 return JSON.stringify(...)）。
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from _common import logged_in_page, goto_route


def main():
    if len(sys.argv) < 3:
        print("用法: python eval.py <route|url> <jsfile>")
        sys.exit(2)
    route, jsfile = sys.argv[1], sys.argv[2]
    code = Path(jsfile).read_text(encoding="utf-8")
    with sync_playwright() as p:
        browser, context, page = logged_in_page(p)
        url = goto_route(page, route)
        print("URL:", url)
        result = page.evaluate(code)
        print("RESULT:", result)
        browser.close()


if __name__ == "__main__":
    main()
