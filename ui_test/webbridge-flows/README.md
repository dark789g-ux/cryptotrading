# ui_test/webbridge-flows

本目录存放**固化、可重放**的 WebBridge 测试流程。

每个 flow 是一个独立的 Python 脚本，运行后输出 `FLOW_OK` 或 `FLOW_BROKEN @ step N`。

## 命名约定

- 文件名用短横线连接的小写 snake_case：`backtest_run_button.py`
- 一个脚本只测一个**锐化后**的目标，例如：
  - ✅ `backtest_run_button.py` —— 验证回测页运行按钮触发 POST 且参数正确
  - ❌ `test_backtest.py` —— 范围太模糊

## 脚本头部必须包含

```python
# 目标：一句话说明测什么
# 上次验证：YYYY-MM-DD
# 关键路径假设：
#   - 前端 dev 服务器在 http://localhost:5173
#   - 页面路径 /backtest
#   - 运行按钮有 data-testid="run-backtest"
#   - 点击后调用 POST /api/backtest/run
```

## 输出约定

- 成功：`print("FLOW_OK: <简短结论>")`
- 失败：`print("FLOW_BROKEN @ step <N>: 期望 <X> 实际 <Y>")`

## 模板

复制 `_template.py` 开始（Windows 用 `Copy-Item`）：

```powershell
Copy-Item ui_test/webbridge-flows/_template.py ui_test/webbridge-flows/<任务>.py
```

## 运行

```powershell
python ui_test/webbridge-flows/<任务>.py
```

## 注意

- **不要把 `@e` ref 写进 flow 脚本里**，页面重新加载后编号会变。
- **探索阶段当前页面内可以用 `@e` ref**快速定位，但固化到 flow 时必须转成 `data-testid` / id / 稳定文本。
- 所有中文直接写在 Python 字符串里，`requests` 会正确处理 UTF-8。
- 如果测试改写了用户偏好/设置，脚本末尾要恢复默认。
- 环境没装 `requests` 时，可改用标准库 `urllib.request`。
- `network` 监听需先 `start` 再 `list`。
