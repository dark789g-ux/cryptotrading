---
name: deepseek-api
description: 调用 DeepSeek API（/chat/completions）的强制查阅规范，覆盖思考模式（reasoning_content / thinking / reasoning_effort）与多轮对话上下文拼接。**任何**涉及 DeepSeek API 的代码编写、修改、排错前必须先调用本 skill。触发词：DeepSeek、deepseek、deepseek-v4-pro、reasoning_content、思考模式、thinking mode、reasoning_effort、deepseek 多轮、deepseek chat completions、api.deepseek.com。
---

# DeepSeek API 使用规范

## 强制要求

**每次涉及 DeepSeek API 的编码/修改/排错前**，必须先阅读本目录下的两份原文档：

- [thinking_mode.md](thinking_mode.md) — 思考模式完整规范（开关、强度、reasoning_content 回传规则、工具调用）
- [multi_round_chat.md](multi_round_chat.md) — 多轮对话上下文拼接规范

**禁止凭记忆/训练数据回答 DeepSeek API 相关问题**：模型名、参数名、reasoning_content 回传规则、思考开关参数格式都必须以本目录文档为准。文档可能随上游更新，每次都要重读。

## 关键红线（先看这一段，再去读原文）

1. **base_url**：`https://api.deepseek.com`，使用 OpenAI SDK 调用。
2. **思考模式开关**：OpenAI 格式下通过 `extra_body={"thinking": {"type": "enabled/disabled"}}` 传入，**不要**写成顶层 `thinking=`。默认开启。
3. **思考强度** `reasoning_effort`：`"high" | "max"`；`low/medium` 会被映射为 `high`，`xhigh` 映射为 `max`。
4. **思考模式禁用参数**：`temperature`、`top_p`、`presence_penalty`、`frequency_penalty` 传了不会报错但不会生效——**不要依赖它们**。
5. **多轮对话是无状态的**：每轮必须自行拼接完整 `messages` 历史回传给 API，服务端不保存上下文。
6. **`reasoning_content` 回传规则**（最容易踩坑）：
   - 两个 user 之间**没有**工具调用 → 中间 assistant 的 `reasoning_content` **无需**回传，回传也会被忽略。
   - 两个 user 之间**有**工具调用 → 该轮所有 assistant 的 `reasoning_content` **必须**完整回传，否则 API 返回 **400**。
   - 安全做法：直接 `messages.append(response.choices[0].message)`，整条 message 对象（含 content / reasoning_content / tool_calls）一起塞回去；流式则手动重建为 `{"role":"assistant","reasoning_content":..., "content":..., "tool_calls":...}`。
7. **工具调用循环**：一个 user turn 内模型可能进行多次思考+工具调用子轮次，需用 `while True` 循环直到 `tool_calls is None` 才算该 turn 结束。

## 自检清单（提交 DeepSeek 相关代码前过一遍）

- [ ] 已重新打开 `thinking_mode.md` 与 `multi_round_chat.md`，核对模型名、参数名拼写
- [ ] `thinking` 参数放在 `extra_body` 而不是顶层
- [ ] 没有给思考模式请求传 `temperature / top_p / presence_penalty / frequency_penalty`
- [ ] 多轮对话每次请求都拼接了完整历史
- [ ] 若有 `tools=` 参数：所有后续轮次都保留并回传了 `reasoning_content`
- [ ] 流式场景下，`reasoning_content` 与 `content` 分别累加再 append 回 messages
- [ ] API Key / base_url 走环境变量，不硬编码

## 排错顺序

DeepSeek API 返回异常时按以下顺序排查（与 CLAUDE.md 中第三方 API 集成规范一致）：

1. 重读 [thinking_mode.md](thinking_mode.md) / [multi_round_chat.md](multi_round_chat.md) 对照参数
2. 打印发送给 API 的完整 `messages` 与请求体，看真实响应
3. 最后才读内部封装实现

**400 报错最常见原因**：含工具调用的历史轮次漏传 `reasoning_content`。

## 文档来源

- https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
- https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat

如发现本目录文档与上述 URL 不一致，**以 URL 为准**，并用 local-webfetch 重新抓取覆盖本目录文件。
