"""验证当前登录态：带 storage_state 调 /api/auth/me，打印状态码 + 用户。
用法: python .browser-driving/scripts/check_auth.py
"""
from playwright.sync_api import sync_playwright

from _common import load_config, launch, new_context


def main():
    cfg = load_config()
    with sync_playwright() as p:
        browser = launch(p, cfg)
        context = new_context(browser, cfg, use_state=True)
        resp = context.request.get(cfg["apiBaseUrl"].rstrip("/") + "/auth/me")
        print(f"/auth/me -> HTTP {resp.status}")
        if resp.status == 200:
            print("LOGGED_IN:", resp.text()[:200])
        else:
            print("NOT_LOGGED_IN —— 先跑 login.py 建立登录态。")
        browser.close()


if __name__ == "__main__":
    main()
