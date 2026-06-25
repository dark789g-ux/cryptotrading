"""登录并把登录态存到 storage_state.json，供后续脚本复用。幂等：重复跑会刷新登录态。
用法: python .browser-driving/scripts/login.py
"""
from playwright.sync_api import sync_playwright

from _common import load_config, launch, new_context, is_logged_in, login, save_state


def main():
    cfg = load_config()
    with sync_playwright() as p:
        browser = launch(p, cfg)
        context = new_context(browser, cfg, use_state=True)
        if is_logged_in(context, cfg):
            print("已是登录态（复用 storage_state），刷新中…")
        login(context, cfg)
        path = save_state(context)
        resp = context.request.get(cfg["apiBaseUrl"].rstrip("/") + "/auth/me")
        print(f"LOGIN_OK  /auth/me -> HTTP {resp.status}")
        if resp.status == 200:
            print("USER:", resp.text()[:200])
        print("STATE_SAVED:", path)
        browser.close()


if __name__ == "__main__":
    main()
