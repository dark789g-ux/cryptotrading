---
name: local-webfetch
description: 在本地机器上抓取网页内容，绕过 WebFetch 工具的海外域名限制。当用户需要访问国内站点（如 tushare.pro、东方财富、同花顺等）或 WebFetch 失败时，使用此技能。触发词：抓取网页、获取网页内容、fetch、爬取、访问网址、网页内容、WebFetch 失败。
---

# Local WebFetch

在本地机器上通过 PowerShell 抓取网页，解决 WebFetch 工具因海外服务器无法访问国内站点的问题。

## 使用方式

运行 skill 目录下的 Python 脚本：

```bash
python <skill-dir>/fetch.py "<目标URL>" [-s "<标签选择器>"] [-m <字符数>]
```

参数说明：
- 第一个参数：目标 URL（必填）
- `-s / --selector`：可选的 HTML 标签选择器，用于提取页面中的特定元素（如 `table`、`div`）
- `-m / --max-length`：返回内容的最大字符数，默认 50000

## 示例

```bash
# 抓取完整页面
python <skill-dir>/fetch.py "https://tushare.pro/document/2?doc_id=348"

# 只提取 table 元素
python <skill-dir>/fetch.py "https://tushare.pro/document/2?doc_id=348" -s "table"
```

## 注意事项

- 脚本输出纯文本（已去除 HTML 标签），适合 Claude 直接阅读
- 对于 JavaScript 动态渲染的页面，PowerShell 只能获取初始 HTML，可能不含动态内容
- 如需抓取大量数据，增大 `-MaxLength` 参数
- 编码自动检测，优先使用页面声明的 charset
