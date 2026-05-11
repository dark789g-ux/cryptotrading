# 多轮对话（multi_round_chat）

> 来源：https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat
> 抓取时间：2026-05-12

本指南将介绍如何使用 DeepSeek `/chat/completions` API 进行多轮对话。

DeepSeek `/chat/completions` API 是一个**"无状态" API**，即服务端**不记录**用户请求的上下文，用户在每次请求时，需将之前所有对话历史拼接好后，传递给对话 API。

下面以 Python 为例，展示如何进行上下文拼接，实现多轮对话：

```python
from openai import OpenAI
client = OpenAI(api_key="<DeepSeek API Key>", base_url="https://api.deepseek.com")

# Round 1
messages = [{"role": "user", "content": "What's the highest mountain in the world?"}]
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages
)

messages.append(response.choices[0].message)
print(f"Messages Round 1: {messages}")

# Round 2
messages.append({"role": "user", "content": "What is the second?"})
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=messages
)

messages.append(response.choices[0].message)
print(f"Messages Round 2: {messages}")
```

第一轮请求时，传递给 API 的 `messages`：

```json
[
    {"role": "user", "content": "What's the highest mountain in the world?"}
]
```

第二轮请求时：

1. 将第一轮中模型的输出追加到 `messages` 末尾；
2. 将新的提问追加到 `messages` 末尾。

最终传递给 API 的 `messages`：

```json
[
    {"role": "user", "content": "What's the highest mountain in the world?"},
    {"role": "assistant", "content": "The highest mountain in the world is Mount Everest."},
    {"role": "user", "content": "What is the second?"}
]
```
