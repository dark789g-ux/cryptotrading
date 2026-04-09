# -*- coding: utf-8 -*-
"""
本地 HTML 报告服务（技能参考脚本）

从指定目录启动 HTTP 服务，提供静态 HTML 及 /api/data 接口读取本地 JSON。
用法：修改下方配置后运行 python serve_local.py

配置写在脚本顶部，不使用 argparse。
"""

from __future__ import annotations

import http.server
import json
import socketserver
import sys
import threading
import webbrowser
from pathlib import Path

# ══════════════════════════════════════════════════════════════
#  配置（修改此处）
# ══════════════════════════════════════════════════════════════

PORT = 8888
SERVE_DIR = Path(".")           # 静态文件根目录（HTML、CSS 所在）
DATA_FILE = Path("data/report.json")   # /api/data 返回的 JSON 文件
HTML_FILE = "report.html"       # 默认打开的页面

# ══════════════════════════════════════════════════════════════
#  HTTP Handler
# ══════════════════════════════════════════════════════════════


class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_DIR.resolve()), **kwargs)

    def do_GET(self) -> None:
        if self.path == "/api/data":
            self._serve_data()
        else:
            super().do_GET()

    def _serve_json(self, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _serve_data(self) -> None:
        path = DATA_FILE if DATA_FILE.is_absolute() else (SERVE_DIR / DATA_FILE)
        if not path.exists():
            self.send_error(404, f"Data file not found: {path}")
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self._serve_json(data)
        except Exception as e:
            self.send_error(500, str(e))

    def log_message(self, fmt, *args) -> None:
        code = args[1] if len(args) > 1 else "?"
        if str(code) not in ("200", "304"):
            print(f"  [{code}] {args[0]}")


# ══════════════════════════════════════════════════════════════
#  入口
# ══════════════════════════════════════════════════════════════


def main() -> None:
    if sys.stdout.encoding != "utf-8":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    url = f"http://localhost:{PORT}/{HTML_FILE}"
    socketserver.TCPServer.allow_reuse_address = True

    with socketserver.TCPServer(("", PORT), _Handler) as httpd:
        print(f"本地服务已启动 → {url}")
        print("按 Ctrl+C 停止\n")
        print("API: GET /api/data → 返回 DATA_FILE 内容")

        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已停止")


if __name__ == "__main__":
    main()
