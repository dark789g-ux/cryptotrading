"""流程：/backtest 策略列表渲染 + 后端 /api/strategies 一致性
上次验证：2026-06-26 通过（feat/money-flow-from-stock-aggregation）
关键路径假设（这些变了脚本会断 → 回交互探索重摸、修好后更新本文件头部）：
  - 路由 /backtest
  - 选择器：策略列表 table tbody tr（默认 pageSize=10 → 通常 10 行）
  - 接口 GET /api/strategies 期望 200，body 形状 {rows:[...], total, page, pageSize}
跑法：
  1) 先起常驻浏览器（后台）：run_in_background python .browser-driving/scripts/serve.py [--port N]
  2) 一步到位重放：python .browser-driving/flows/backtest-strategy-list.py [--port N]
说明：跑完只断开 CDP、浏览器停在终态不关，便于肉眼复核 / 继续操作。
"""
import argparse
import sys
import pathlib

# flows/ 是 scripts/ 的兄弟目录，把 scripts/ 加进 sys.path 才能 import _common
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
            # —— step 1：自己回到起点，保证可重放幂等 ——
            goto_route(page, "/backtest")
            flow_assert(page.url.endswith("/backtest"), 1, "url 落在 /backtest", page.url)

            # —— step 2：策略列表表格已渲染 ——
            rows = page.locator("table tbody tr").count()
            flow_assert(rows >= 1, 2, "策略表 >=1 行", rows)

            # —— step 3：后端策略列表接口可用 ——
            r = ctx.request.get(cfg["apiBaseUrl"].rstrip("/") + "/strategies")
            flow_assert(r.status == 200, 3, "GET /api/strategies 200", r.status)

            # —— step 4：响应形状契约（分页结构）——
            body = r.json()
            ok_shape = isinstance(body, dict) and isinstance(body.get("rows"), list) and "total" in body
            flow_assert(ok_shape, 4, "body 形如 {rows:[...], total}", list(body.keys()) if isinstance(body, dict) else type(body).__name__)

            # —— 留证 ——
            shot(page, "flow_backtest_strategy_list.png")
            print(f"FLOW_OK table_rows={rows} api_rows={len(body['rows'])} total={body['total']} url={page.url}")
        finally:
            browser.close()   # 只断开 CDP，浏览器停终态不关


if __name__ == "__main__":
    main()
