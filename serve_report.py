"""
本地报告服务器

从项目根目录启动一个轻量 HTTP 服务器，并自动在浏览器中打开 report.html。
回测结果按时间戳存放于 backtest_results/<YYYYMMDD_HHMMSS>/ 子目录，
前端通过 /api/runs 获取可用的回测记录列表，再动态加载对应子目录下的 report_data.json。

用法：
    python serve_report.py

前端开发工作流：
    1. 先运行一次回测：python backtest_strategy.py（生成带时间戳的子目录）
    2. 启动本服务：python serve_report.py
    3. 直接编辑根目录下的 report.html，刷新浏览器即可
    4. 无需重跑回测
"""

from __future__ import annotations

import http.server
import json
import re
import socketserver
import threading
import webbrowser
from pathlib import Path

# ══════════════════════════════════════════════════════════════
#  配置
# ══════════════════════════════════════════════════════════════

PORT        = 8888
SERVE_DIR   = Path(".")          # 从项目根目录提供服务
RESULTS_DIR = Path("backtest_results")

_RUN_ID_RE = re.compile(r'^\d{8}_\d{6}$')


# ══════════════════════════════════════════════════════════════
#  HTTP Handler
# ══════════════════════════════════════════════════════════════

class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_DIR.resolve()), **kwargs)

    def do_GET(self) -> None:
        if self.path == "/api/runs":
            self._serve_runs()
        else:
            super().do_GET()

    def _serve_runs(self) -> None:
        """扫描 backtest_results/ 下的时间戳子目录，返回回测记录列表（最新在前）。"""
        runs: list[dict] = []
        if RESULTS_DIR.exists():
            dirs = sorted(
                (d for d in RESULTS_DIR.iterdir() if d.is_dir() and _RUN_ID_RE.match(d.name)),
                key=lambda d: d.name,
                reverse=True,
            )
            for d in dirs:
                rid = d.name
                run_info: dict = {
                    "run_id":   rid,
                    "run_time": f"{rid[:4]}-{rid[4:6]}-{rid[6:8]} {rid[9:11]}:{rid[11:13]}:{rid[13:15]}",
                }
                data_file = d / "report_data.json"
                if data_file.exists():
                    try:
                        rdata = json.loads(data_file.read_text(encoding="utf-8"))
                        stats = rdata.get("stats", {})
                        run_info["total_return"]    = stats.get("总收益率",       "")
                        run_info["max_dd"]          = stats.get("最大回撤",       "")
                        run_info["win_rate"]        = stats.get("胜率(完整出场)", "")
                        run_info["total_positions"] = rdata.get("total_positions", 0)
                    except Exception:
                        pass
                runs.append(run_info)

        body = json.dumps(runs, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type",   "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control",  "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args) -> None:
        code = args[1] if len(args) > 1 else "?"
        if str(code) not in ("200", "304"):
            print(f"  [{code}] {args[0]}")


# ══════════════════════════════════════════════════════════════
#  入口
# ══════════════════════════════════════════════════════════════

def main() -> None:
    report_html = Path("report.html")

    if not report_html.exists():
        print("[警告] 未找到 report.html，请检查文件是否存在于项目根目录")

    if RESULTS_DIR.exists():
        runs = [d for d in RESULTS_DIR.iterdir() if d.is_dir() and _RUN_ID_RE.match(d.name)]
        if not runs:
            print("[警告] backtest_results/ 下无回测记录，请先运行：python backtest_strategy.py")
    else:
        print("[警告] 未找到 backtest_results/ 目录，请先运行：python backtest_strategy.py")

    url = f"http://localhost:{PORT}/report.html"

    socketserver.TCPServer.allow_reuse_address = True

    with socketserver.TCPServer(("", PORT), _Handler) as httpd:
        print(f"报告服务已启动 → {url}")
        print("按 Ctrl+C 停止服务\n")
        print("前端开发提示：")
        print("  • 直接编辑根目录的 report.html，刷新浏览器即可")
        print("  • 回测记录列表：GET /api/runs")
        print("  • 数据文件：backtest_results/<run_id>/report_data.json")

        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已停止")


if __name__ == "__main__":
    main()
