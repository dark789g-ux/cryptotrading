# -*- coding: utf-8 -*-
"""Local web fetch - fetches web pages from the local machine to bypass WebFetch geo-restrictions."""

import sys
import argparse
import re
import html
import urllib.request
import ssl


def fetch_url(url: str, selector: str | None = None, max_length: int = 50000) -> str:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    })

    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        raw = resp.read()
        content = raw.decode(charset, errors="replace")

    if selector:
        pattern = rf"(?s)<{selector}\b[^>]*>.*?</{selector}>"
        found = re.findall(pattern, content)
        if found:
            content = "\n".join(found)
        else:
            print(f"WARNING: Selector '{selector}' not found, returning full page", file=sys.stderr)

    # strip script/style/comments
    text = re.sub(r"(?s)<script\b[^>]*>.*?</script>", "", content)
    text = re.sub(r"(?s)<style\b[^>]*>.*?</style>", "", text)
    text = re.sub(r"(?s)<!--.*?-->", "", text)

    # block elements -> newline
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    for tag in ("p", "div", "li", "tr"):
        text = re.sub(rf"(?i)</{tag}>", "\n", text)
    text = re.sub(r"(?i)</h[1-6]>", "\n", text)

    # table cells -> tab
    text = re.sub(r"(?i)<th[^>]*>", "\t", text)
    text = re.sub(r"(?i)<td[^>]*>", "\t", text)

    # strip remaining tags
    text = re.sub(r"<[^>]+>", "", text)

    # decode entities
    text = html.unescape(text)

    # collapse blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip()

    if len(text) > max_length:
        text = text[:max_length] + f"\n... [truncated, total {len(text)} chars]"

    return text


def main():
    parser = argparse.ArgumentParser(description="Local web fetch")
    parser.add_argument("url", help="Target URL")
    parser.add_argument("-s", "--selector", help="CSS-like tag selector (e.g. table, div)")
    parser.add_argument("-m", "--max-length", type=int, default=50000, help="Max output chars")
    args = parser.parse_args()

    result = fetch_url(args.url, args.selector, args.max_length)
    sys.stdout.reconfigure(encoding="utf-8")
    print(result)


if __name__ == "__main__":
    main()
