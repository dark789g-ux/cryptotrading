"""起一个常驻 headed 浏览器实例并 hold 住，供后续脚本 attach（探索/固化/peek 都连它）。

端口即实例：不同 --port 起不同浏览器 + 不同持久 profile（.user-data/<port>），互不串扰。
跑法（务必后台跑，否则会阻塞）：
    run_in_background: python .browser-driving/scripts/serve.py [--port 9222]
停止：TaskStop 这个后台任务（进程退出 → 浏览器随之关闭）。
起之前先用 peek.py 探测同端口是否已有常驻浏览器，有就直接复用、别重复起。
"""
import argparse
import time

from playwright.sync_api import sync_playwright

from _common import load_config, serve


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None, help="CDP 端口（默认取 config.cdpPort=9222）；端口即实例标识")
    args = ap.parse_args()

    cfg = load_config()
    port = int(args.port or cfg["cdpPort"])

    with sync_playwright() as p:
        serve(p, cfg, port=port)
        print(
            f"BROWSER_UP cdp=http://127.0.0.1:{port}"
            f" | attach 用端口 {port}（from _common import attach）"
            f" | 停止: TaskStop 本任务",
            flush=True,
        )
        # hold 住，让浏览器常驻；被 TaskStop/kill 打断即退出，persistent context 随之关闭
        while True:
            time.sleep(3600)


if __name__ == "__main__":
    main()
