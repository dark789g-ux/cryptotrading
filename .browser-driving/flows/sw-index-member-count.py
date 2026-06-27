"""流程：验证申万指数「个股数」修复及成分股跳转（一级/二级/三级全层级）
上次验证：2026-06-26 通过（后端重启后最新代码）
关键路径假设（这些变了脚本会断 → 回交互探索重摸、修好后更新本文件头部）：
  - 路由 /symbols → A 股数据 → A 股指数 → 申万指数
  - 选择器：一级/二级/三级 radio 用 .n-radio-button 文本定位
  - 申万表格 testid = a-shares-index-sw-table，tbody tr 取行
  - 接口 GET /api/indices/latest?type=sw&level=N 响应极慢（~35s），需大超时
  - 个股数列在倒数第二列（action 列之前），按 \t 分割取 parts[-2]
  - 成分股按钮在每行末尾，force=True 点击避 loading 遮罩拦截
  - 跳转后 A 股列表用 .n-data-table 通用选择器定位（无专用 testid）
跑法：
  1) 先起常驻浏览器（后台）：run_in_background python .browser-driving/scripts/serve.py [--port N]
  2) 一步到位重放：python .browser-driving/flows/sw-index-member-count.py [--port N]
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
            # —— 自己回到起点，保证可重放幂等 ——
            goto_route(page, "/symbols")
            page.wait_for_timeout(2000)

            # Click "A 股数据" tab
            page.locator('button:has-text("A 股数据")').click()
            page.wait_for_timeout(2000)

            # Click "A 股指数" tab
            page.locator('.n-tabs-tab:has-text("A 股指数")').click()
            page.wait_for_timeout(2000)

            # Click "申万指数" tab - need to wait for the nested tab to be visible after A股指数 tab click
            page.locator('.n-tabs-tab:has-text("申万指数")').click()
            page.wait_for_timeout(35000)

            # === Step 1: 一级层级 农林牧渔 个股数 = 126 ===
            table = page.locator('[data-testid="a-shares-index-sw-table"]')
            rows = table.locator('tbody tr')
            found_nonglin = False
            nonglin_count = None
            for i in range(rows.count()):
                txt = rows.nth(i).inner_text()
                if "农林牧渔" in txt:
                    found_nonglin = True
                    parts = txt.split('\t')
                    nonglin_count = parts[-2] if len(parts) >= 2 else None
                    break
            flow_assert(found_nonglin and nonglin_count == "126", 1,
                        "农林牧渔 个股数 = 126", f"found={found_nonglin}, count={nonglin_count}")

            # === Step 2: Click 农林牧渔 成分股 → A股列表非空 ===
            nonglin_row = None
            for i in range(rows.count()):
                if "农林牧渔" in rows.nth(i).inner_text():
                    nonglin_row = rows.nth(i)
                    break
            flow_assert(nonglin_row is not None, 2, "找到 农林牧渔 行", "not found")
            btn = nonglin_row.locator('button:has-text("成分股")')
            flow_assert(btn.count() > 0, 2, "成分股按钮存在", f"count={btn.count()}")
            btn.click()
            page.wait_for_timeout(5000)

            generic_table = page.locator('.n-data-table')
            flow_assert(generic_table.count() > 0, 2, "A股列表表格存在", f"count={generic_table.count()}")
            stock_count = generic_table.first.locator('tbody tr').count()
            flow_assert(stock_count > 0, 2, "A股列表行数 > 0", stock_count)

            # === Step 3: 三级 黄金 个股数 = 13，跳转非空 ===
            page.locator('.n-tabs-tab:has-text("A 股指数")').click()
            page.wait_for_timeout(2000)
            page.locator('.n-tabs-tab:has-text("申万指数")').click()
            page.wait_for_timeout(5000)

            page.locator('.n-radio-button:has-text("三级")').click()
            page.wait_for_timeout(5000)

            # Search for 黄金
            search_input = page.locator('.search-input input')
            search_input.fill("黄金")
            page.keyboard.press("Enter")
            page.wait_for_timeout(5000)

            table = page.locator('[data-testid="a-shares-index-sw-table"]')
            rows = table.locator('tbody tr')
            found_gold = False
            gold_count = None
            for i in range(rows.count()):
                txt = rows.nth(i).inner_text()
                if "黄金" in txt:
                    found_gold = True
                    parts = txt.split('\t')
                    gold_count = parts[-2] if len(parts) >= 2 else None
                    break
            flow_assert(found_gold and gold_count == "13", 3,
                        "黄金 个股数 = 13", f"found={found_gold}, count={gold_count}")

            gold_row = None
            for i in range(rows.count()):
                if "黄金" in rows.nth(i).inner_text():
                    gold_row = rows.nth(i)
                    break
            flow_assert(gold_row is not None, 3, "找到 黄金 行", "not found")
            gold_btn = gold_row.locator('button:has-text("成分股")')
            flow_assert(gold_btn.count() > 0, 3, "黄金 成分股按钮存在", f"count={gold_btn.count()}")
            gold_btn.click()
            page.wait_for_timeout(5000)

            generic_table = page.locator('.n-data-table')
            gold_stock_count = generic_table.first.locator('tbody tr').count()
            flow_assert(gold_stock_count > 0, 3, "黄金 成分股列表行数 > 0", gold_stock_count)

            # === Step 4: 二级层级任意个股数 > 0，跳转非空 ===
            page.locator('.n-tabs-tab:has-text("A 股指数")').click()
            page.wait_for_timeout(2000)
            page.locator('.n-tabs-tab:has-text("申万指数")').click()
            page.wait_for_timeout(5000)

            page.locator('.n-radio-button:has-text("二级")').click()
            page.wait_for_timeout(5000)

            table = page.locator('[data-testid="a-shares-index-sw-table"]')
            rows = table.locator('tbody tr')
            level2_found = False
            level2_name = None
            level2_count = None
            for i in range(rows.count()):
                txt = rows.nth(i).inner_text()
                parts = txt.split('\t')
                if len(parts) >= 2:
                    count_val = parts[-2]
                    if count_val.isdigit() and int(count_val) > 0:
                        level2_found = True
                        level2_name = parts[1]
                        level2_count = count_val
                        break
            flow_assert(level2_found, 4, "找到二级层级个股数 > 0 的行",
                        f"found={level2_found}, name={level2_name}, count={level2_count}")

            level2_row = None
            for i in range(rows.count()):
                if level2_name in rows.nth(i).inner_text():
                    level2_row = rows.nth(i)
                    break
            if level2_row:
                page.wait_for_timeout(2000)
                l2_btn = level2_row.locator('button:has-text("成分股")')
                if l2_btn.count() > 0:
                    l2_btn.click(force=True)
                    page.wait_for_timeout(5000)
                    generic_table = page.locator('.n-data-table')
                    l2_stock_count = generic_table.first.locator('tbody tr').count()
                    flow_assert(l2_stock_count > 0, 4, "二级成分股列表行数 > 0", l2_stock_count)

            # —— 留证 ——
            shot(page, "sw_index_all_assertions.png")
            print(f"FLOW_OK 申万指数个股数修复验证通过: 一级农林牧渔={nonglin_count}, 三级黄金={gold_count}, 二级={level2_name}({level2_count})")
        finally:
            browser.close()   # 只断开 CDP，浏览器停终态不关


if __name__ == "__main__":
    main()
