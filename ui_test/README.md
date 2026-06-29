# ui_test

本目录存放基于 **Kimi WebBridge** 的前端 UI / e2e 测试脚本与固化流程。

与 Playwright 不同，这里的测试直接控制用户的真实浏览器（复用登录态、cookie、localStorage），
适合验证「真实用户视角」的交互链路。

## 目录结构

```text
ui_test/
├── README.md                        # 本文件
├── test_config.json                 # 测试参数（账号、URL 等）
├── test_config.example.json         # test_config.json 模板
├── webbridge-flows/                 # 固化可重放的测试流程
│   ├── README.md
│   └── _template.py                 # 新建 flow 的模板（Python）
├── .tmp/                            # 探索阶段临时脚本（不提交）
└── lessons-learned.md               # 通用踩坑经验
```

## 快速开始

1. 确保 Kimi WebBridge daemon 在跑：
   ```python
   import socket
   sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
   print(sock.connect_ex(("127.0.0.1", 10086)) == 0)
   sock.close()
   ```
   如果为 False，启动它：
   ```powershell
   & "$env:USERPROFILE\.kimi-webbridge\bin\kimi-webbridge.exe" start
   ```

2. 配置测试参数：
   ```powershell
   Copy-Item ui_test/test_config.example.json ui_test/test_config.json
   ```
   然后编辑 `ui_test/test_config.json`：
   - `auth.email` / `auth.password`：填入测试账号密码
   - `api_base_url`：必须包含 `/api` 前缀（如 `http://localhost:3000/api`）
   - `webbridge_url`：WebBridge daemon 地址（默认 `http://127.0.0.1:10086/command`）

3. 复制模板创建新 flow：
   ```powershell
   Copy-Item ui_test/webbridge-flows/_template.py ui_test/webbridge-flows/<任务>.py
   ```

4. 修改并运行：
   ```powershell
   python ui_test/webbridge-flows/<任务>.py
   ```

## 设计原则

- **URL 直达优先**：能 `navigate` 到具体路径，就不要从首页一步步点进来。
- **稳定定位**：用 `data-testid`、稳定 `id` 或文本来定位，**禁止把 `@e` ref 写进 flow 脚本**。
- **程序化断言**：用 `evaluate`、`network`、`snapshot` 获取证据，不要靠「肉眼看起来对」。
- **Python 直接 POST JSON**：通过 `requests` 发送 JSON 到 `http://127.0.0.1:10086/command`，
  不需要写临时文件，中文也不会损坏。
- **敏感信息进 test_config.json**：账号、密码等测试参数统一放这里，flow 脚本只读取，不硬编码。

## 相关文档

- Agent 定义：`.claude/agents/browser-tester.md`
- Kimi WebBridge Skill：`.claude/skills/kimi-webbridge/SKILL.md`

## 安全提示

`test_config.json` 包含敏感信息，**不要提交到 git**。仓库 `.gitignore` 已忽略：

```gitignore
ui_test/test_config.json
ui_test/.tmp/
```
