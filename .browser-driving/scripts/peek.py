"""只读快照 + 探测常驻浏览器是否在跑。不改页面、不导航。

用途：
  1) 起 serve 前先探测同端口有没有现成常驻浏览器（连得上就复用、别重复起）；
  2) 随时「看一眼浏览器现在停在哪、什么状态」（探索/固化跑完复核终态）。
跑法：python .browser-driving/scripts/peek.py [--port 9222]
连不上：打印「serve(:port) 没起或已死」并以非零码退出（可据此判断要不要起 serve）。
"""
import argparse
import sys

from playwright.sync_api import sync_playwright

from _common import load_config, attach, dump_routes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None, help="CDP 端口（默认取 config.cdpPort=9222）")
    args = ap.parse_args()

    cfg = load_config()
    port = int(args.port or cfg["cdpPort"])

    with sync_playwright() as p:
        try:
            browser, ctx, page = attach(p, cfg, port=port)
        except Exception as e:
            print(f"NO_SERVE :{port} 没起或已死（{type(e).__name__}: {e}）", file=sys.stderr)
            sys.exit(2)
        try:
            main_len = page.evaluate(
                "(()=>{const m=document.querySelector('main');return (m&&m.innerText||'').length;})()"
            )
            routes = [r for r in dump_routes(page).split("\n") if r][:8]
            print(f"SERVE_UP :{port}")
            print("URL  :", page.url)
            print("TITLE:", page.title())
            print("MAIN_TEXT_LEN:", main_len)
            print("ROUTES(前8):", routes)
            print("TABS:", len(ctx.pages))
        finally:
            browser.close()   # 只断开 CDP，常驻浏览器不动


if __name__ == "__main__":
    main()
