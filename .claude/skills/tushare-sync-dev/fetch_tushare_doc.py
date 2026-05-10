# -*- coding: utf-8 -*-
"""
查询 Tushare 接口文档。
从 references/数据接口.md 中查找接口对应的 .md 文档链接，然后本地抓取并输出。

用法:
    python fetch_tushare_doc.py <接口名>
    python fetch_tushare_doc.py moneyflow_ths
    python fetch_tushare_doc.py --list              # 列出所有接口
    python fetch_tushare_doc.py --search 资金流向    # 按关键词搜索接口
"""

import sys
import os
import re
import html
import urllib.request
import ssl

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_FILE = os.path.join(SCRIPT_DIR, "references", "数据接口.md")


def load_index() -> list[dict]:
    """解析数据接口.md，返回 [{name, title, category, description, url}]"""
    with open(INDEX_FILE, encoding="utf-8") as f:
        content = f.read()

    # 匹配 markdown 表格行: | [接口名](url) | 标题 | 分类 | 描述 |
    pattern = r"\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|"
    entries = []
    for m in re.finditer(pattern, content):
        entries.append({
            "name": m.group(1).strip(),
            "url": m.group(2).strip(),
            "title": m.group(3).strip(),
            "category": m.group(4).strip(),
            "description": m.group(5).strip(),
        })
    return entries


def find_entry(entries: list[dict], name: str) -> dict | None:
    """精确匹配接口名"""
    for e in entries:
        if e["name"] == name:
            return e
    return None


def search_entries(entries: list[dict], keyword: str) -> list[dict]:
    """按关键词搜索接口名/标题/分类/描述"""
    kw = keyword.lower()
    return [e for e in entries if kw in e["name"].lower()
            or kw in e["title"].lower()
            or kw in e["category"].lower()
            or kw in e["description"].lower()]


def fetch_md(url: str) -> str:
    """抓取 .md 文档内容"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    })
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        return resp.read().decode(resp.headers.get_content_charset() or "utf-8", errors="replace")


def main():
    if len(sys.argv) < 2:
        print("用法: python fetch_tushare_doc.py <接口名>")
        print("      python fetch_tushare_doc.py --list")
        print("      python fetch_tushare_doc.py --search <关键词>")
        sys.exit(1)

    entries = load_index()

    arg = sys.argv[1]

    if arg == "--list":
        for e in entries:
            print(f"  {e['name']:<30s} {e['title']:<20s} {e['category']}")
        return

    if arg == "--search":
        keyword = " ".join(sys.argv[2:]) if len(sys.argv) > 2 else ""
        if not keyword:
            print("请提供搜索关键词")
            sys.exit(1)
        results = search_entries(entries, keyword)
        if not results:
            print(f"未找到匹配 '{keyword}' 的接口")
            return
        for e in results:
            print(f"  {e['name']:<30s} {e['title']:<20s} {e['url']}")
        return

    # 查询单个接口
    entry = find_entry(entries, arg)
    if not entry:
        # 尝试模糊匹配
        results = search_entries(entries, arg)
        if results:
            print(f"未找到精确匹配 '{arg}'，你是否想找：")
            for e in results:
                print(f"  {e['name']:<30s} {e['title']}")
        else:
            print(f"未找到接口 '{arg}'，请确认接口名或使用 --list 查看所有接口")
        sys.exit(1)

    print(f"# {entry['name']} — {entry['title']}")
    print(f"# 分类: {entry['category']}")
    print(f"# 文档: {entry['url']}")
    print()

    try:
        content = fetch_md(entry["url"])
        print(content)
    except Exception as e:
        print(f"抓取文档失败: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
