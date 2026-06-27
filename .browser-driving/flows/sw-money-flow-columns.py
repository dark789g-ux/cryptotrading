"""流程：验证 A 股指数列设置-资金流字段模块（申万 + 同花顺面板）
上次验证：2026-06-27 通过（feat/table-column-prefs-generalization 分支）
关键路径假设（这些变了脚本会断 → 回交互探索重摸、修好后更新本文件头部）：
  - 路由 /symbols → A 股数据 tab → A 股指数子 tab → 申万/同花顺面板
  - 选择器：顶层 tab「A 股数据」get_by_role("tab", name="A 股数据")
  - 选择器：子 tab「A 股指数」locator("text=A 股指数").first.click()
  - 选择器：申万面板 locator("text=申万").first.click()
  - 选择器：同花顺面板 locator("text=同花顺").first.click()
  - 选择器：列设置按钮 get_by_role("button", name="列设置")
  - 选择器：列设置 dialog [role='dialog']，分组用 .n-collapse-item，列项用 .column-settings-grid-item
  - 资金流分组 key='moneyFlow'，含 7 列：净流入/5日净流入/10日净流入/20日净流入/大单净流入/中单净流入/小单净流入
  - naive-ui n-checkbox 状态通过 className "n-checkbox--checked" 判断，点击 .n-checkbox 元素 toggle
  - 申万表格 data-testid='a-shares-index-sw-table'
  - 后端接口 GET /api/indices/latest?category=sw&swLevel=N 返回 netAmount/netAmount5d/netAmount10d/netAmount20d
  - 数据：一级/二级资金流列有非空数值（带 亿/万 单位），三级可能部分空（历史原因）
跑法：
  1) 先起常驻浏览器（后台）：run_in_background python .browser-driving/scripts/serve.py [--port N]
  2) 一步到位重放：python .browser-driving/flows/<本文件> [--port N]
说明：跑完只断开 CDP、浏览器停在终态不关，便于肉眼复核 / 继续操作。
"""
import argparse
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))

from playwright.sync_api import sync_playwright

from _common import load_config, attach, goto_route, flow_assert, shot


def toggle_checkbox(group, label, page):
    """点击 naive-ui n-checkbox 切换状态（通过 className 判断是否已勾选）。"""
    item = group.locator(".column-settings-grid-item").filter(has_text=label)
    if item.count() > 0:
        n_checkbox = item.first.locator(".n-checkbox")
        if n_checkbox.count() > 0:
            cls = n_checkbox.first.evaluate("el => el.className")
            if "n-checkbox--checked" not in cls:
                n_checkbox.first.click()
                page.wait_for_timeout(300)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None, help="连哪个常驻实例（默认 config.cdpPort=9222）")
    args = ap.parse_args()

    cfg = load_config()
    port = int(args.port or cfg["cdpPort"])

    with sync_playwright() as p:
        browser, ctx, page = attach(p, cfg, port=port)
        try:
            # ===== 剧本 1：申万面板列设置有「资金流」分组，含 7 列 =====
            goto_route(page, "/symbols")
            page.wait_for_timeout(3000)

            a_shares_tab = page.get_by_role("tab", name="A 股数据")
            flow_assert(a_shares_tab.count() > 0, 1, "A 股数据 tab 存在", a_shares_tab.count())
            a_shares_tab.click()
            page.wait_for_timeout(2000)

            index_tab = page.locator("text=A 股指数")
            flow_assert(index_tab.count() > 0, 2, "A 股指数 tab 存在", index_tab.count())
            index_tab.first.click()
            page.wait_for_timeout(2000)

            sw_tab = page.locator("text=申万")
            flow_assert(sw_tab.count() > 0, 3, "申万 tab 存在", sw_tab.count())
            sw_tab.first.click()
            page.wait_for_timeout(2000)

            col_settings = page.get_by_role("button", name="列设置")
            flow_assert(col_settings.count() > 0, 4, "列设置按钮存在", col_settings.count())
            col_settings.click()
            page.wait_for_timeout(2000)

            dialog = page.locator("[role='dialog']")
            flow_assert(dialog.is_visible(), 5, "列设置 dialog 打开", dialog.is_visible())

            # 检查「资金流」分组存在
            money_flow_group = dialog.locator(".n-collapse-item").filter(has_text="资金流")
            flow_assert(money_flow_group.count() > 0, 6, "资金流分组存在", money_flow_group.count())

            # 展开并检查 7 列
            header = money_flow_group.locator(".n-collapse-item__header")
            header.first.click()
            page.wait_for_timeout(500)

            items = money_flow_group.locator(".column-settings-grid-item").all_inner_texts()
            expected_labels = ["净流入", "5日净流入", "10日净流入", "20日净流入", "大单净流入", "中单净流入", "小单净流入"]
            for label in expected_labels:
                found = any(label in it for it in items)
                flow_assert(found, 7, f"资金流分组含 {label}", items)

            # 检查「其它」分组不再包含这些列
            other_group = dialog.locator(".n-collapse-item").filter(has_text="其它")
            if other_group.count() > 0:
                other_header = other_group.locator(".n-collapse-item__header")
                other_header.first.click()
                page.wait_for_timeout(500)
                other_items = other_group.locator(".column-settings-grid-item").all_inner_texts()
                for label in expected_labels:
                    found = any(label in it for it in other_items)
                    flow_assert(not found, 8, f"其它分组不含 {label}", other_items)

            print("SCRIPT_1_PASSED: 申万面板资金流分组存在且含7列，不再散落在其它分组")

            # ===== 剧本 2：多周期列有真实数值 =====
            # 勾选 5日/10日/20日净流入（如果未勾选）
            for label in ["5日净流入", "10日净流入", "20日净流入"]:
                toggle_checkbox(money_flow_group, label, page)

            # 同时确保「净流入」也勾选（用于对比）
            toggle_checkbox(money_flow_group, "净流入", page)

            save_btn = dialog.get_by_role("button", name="保存")
            flow_assert(save_btn.count() > 0, 9, "保存按钮存在", save_btn.count())
            save_btn.click()
            page.wait_for_timeout(5000)

            table = page.locator("[data-testid='a-shares-index-sw-table']")
            flow_assert(table.is_visible(), 10, "申万表格可见", table.is_visible())
            headers = table.locator("thead th").all_inner_texts()

            for col in ["净流入", "5日净流入", "10日净流入", "20日净流入"]:
                flow_assert(col in headers, 11, f"表头含 {col}", headers)

            rows = table.locator("tbody tr").all()
            flow_assert(len(rows) >= 3, 12, "至少3行数据", len(rows))

            net5_idx = headers.index("5日净流入") if "5日净流入" in headers else -1
            net10_idx = headers.index("10日净流入") if "10日净流入" in headers else -1
            net20_idx = headers.index("20日净流入") if "20日净流入" in headers else -1

            samples = []
            for i, row in enumerate(rows[:5]):
                cells = row.locator("td").all_inner_texts()
                samples.append(cells)

            # 验证多周期列有非空数值（带单位）
            for i, cells in enumerate(samples[:3]):
                for col_idx, col_name in [(net5_idx, "5日净流入"), (net10_idx, "10日净流入"), (net20_idx, "20日净流入")]:
                    if col_idx >= 0 and col_idx < len(cells):
                        val = cells[col_idx].strip()
                        flow_assert(val and val != "-", 13, f"row{i} {col_name} 非空", val)
                        flow_assert(any(u in val for u in ["亿", "万"]), 14, f"row{i} {col_name} 带金额单位", val)

            # 打印样本数据作为证据
            print(f"Sample row 0: {samples[0]}")
            print(f"Sample row 1: {samples[1]}")
            print(f"Sample row 2: {samples[2]}")
            print("SCRIPT_2_PASSED: 多周期列有真实数值（带金额单位）")

            # ===== 剧本 3：排序生效 =====
            net5_header = table.locator("thead th").filter(has_text="5日净流入")
            flow_assert(net5_header.count() > 0, 15, "5日净流入表头存在", net5_header.count())

            rows_before = table.locator("tbody tr").all()
            first_row_before = rows_before[0].locator("td").all_inner_texts() if rows_before else []

            net5_header.first.click()
            page.wait_for_timeout(3000)

            rows_after = table.locator("tbody tr").all()
            first_row_after = rows_after[0].locator("td").all_inner_texts() if rows_after else []

            # 检查表头有排序标记
            net5_header_after = table.locator("thead th").filter(has_text="5日净流入")
            header_html = net5_header_after.first.evaluate("el => el.outerHTML")
            has_sort_indicator = "n-data-table-th--sorting" in header_html

            order_changed = first_row_before != first_row_after
            flow_assert(order_changed or has_sort_indicator, 16, "排序有变化或有排序指示器",
                        f"order_changed={order_changed}, has_sort_indicator={has_sort_indicator}")

            # 验证排序后值有差异（不是全部相同）
            if net5_idx >= 0 and len(rows_after) >= 2:
                vals = []
                for row in rows_after[:5]:
                    cells = row.locator("td").all_inner_texts()
                    if net5_idx < len(cells):
                        vals.append(cells[net5_idx].strip())
                unique_vals = set(vals)
                flow_assert(len(unique_vals) > 1, 17, "排序后5日净流入值有差异", vals)

            print(f"Sort evidence: header has sorting class={has_sort_indicator}, first row changed={order_changed}")
            print("SCRIPT_3_PASSED: 5日净流入排序生效")

            # ===== 剧本 4：同花顺面板也有「资金流」分组 =====
            ths_tab = page.locator("text=同花顺")
            flow_assert(ths_tab.count() > 0, 18, "同花顺 tab 存在", ths_tab.count())
            ths_tab.first.click()
            page.wait_for_timeout(2000)

            col_settings = page.get_by_role("button", name="列设置")
            flow_assert(col_settings.count() > 0, 19, "同花顺列设置按钮存在", col_settings.count())
            col_settings.click()
            page.wait_for_timeout(2000)

            dialog = page.locator("[role='dialog']")
            flow_assert(dialog.is_visible(), 20, "同花顺列设置 dialog 打开", dialog.is_visible())

            ths_money_flow_group = dialog.locator(".n-collapse-item").filter(has_text="资金流")
            flow_assert(ths_money_flow_group.count() > 0, 21, "同花顺面板有资金流分组", ths_money_flow_group.count())

            ths_header = ths_money_flow_group.locator(".n-collapse-item__header")
            ths_header.first.click()
            page.wait_for_timeout(500)

            ths_items = ths_money_flow_group.locator(".column-settings-grid-item").all_inner_texts()
            for label in expected_labels:
                found = any(label in it for it in ths_items)
                flow_assert(found, 22, f"同花顺资金流分组含 {label}", ths_items)

            print("SCRIPT_4_PASSED: 同花顺面板也有资金流分组且含7列")

            shot(page, "sw_money_flow_columns_all_scripts.png")
            print(f"FLOW_OK 申万+同花顺资金流列验证全部通过")

            # ===== 恢复默认列设置，不在用户账号留脚印 =====
            # 先关闭当前 dialog
            cancel_btn = dialog.get_by_role("button", name="取消")
            if cancel_btn.count() > 0:
                cancel_btn.click()
                page.wait_for_timeout(500)

            # 回到申万面板恢复默认
            sw_tab = page.locator("text=申万")
            if sw_tab.count() > 0:
                sw_tab.first.click()
                page.wait_for_timeout(2000)

                col_settings = page.get_by_role("button", name="列设置")
                if col_settings.count() > 0:
                    col_settings.click()
                    page.wait_for_timeout(2000)
                    dialog = page.locator("[role='dialog']")
                    if dialog.is_visible():
                        reset_btn = dialog.get_by_role("button", name="恢复默认")
                        if reset_btn.count() > 0:
                            reset_btn.click()
                            page.wait_for_timeout(500)
                            save_btn = dialog.get_by_role("button", name="保存")
                            if save_btn.count() > 0:
                                save_btn.click()
                                page.wait_for_timeout(2000)
                                print("Column preferences reset to default")

        finally:
            browser.close()


if __name__ == "__main__":
    main()
