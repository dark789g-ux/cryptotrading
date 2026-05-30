"""结构化 JSON 日志。

要求（参见 04-error-quality-testing.md §2 Python warn 双写）：
- 输出 UTC 时间戳
- 支持 job_id 上下文
- warn / error 时由调用方同时写 ml.quality_reports（DB 侧），本文件只负责日志侧
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any


class JsonFormatter(logging.Formatter):
    """简易 JSON formatter；UTC 时间戳；保留 extra 字段。"""

    # 系统保留字段，避免被 extra 覆盖
    _RESERVED = {
        "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
        "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
        "created", "msecs", "relativeCreated", "thread", "threadName",
        "processName", "process", "message", "asctime",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).strftime(
                "%Y-%m-%dT%H:%M:%S.%fZ"
            ),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        # 透传 extra（如 job_id / api_name / params）
        for key, value in record.__dict__.items():
            if key not in self._RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        # default=str：extra 透传的不可序列化对象（numpy 标量、Path、UUID 等）
        # 兜底转字符串，避免 json.dumps 抛 TypeError 拖垮日志（问题 11）。
        return json.dumps(payload, ensure_ascii=False, default=str)


def setup_logging(level: int = logging.INFO) -> None:
    """配置 root logger 为 JSON 输出到 stderr。"""

    root = logging.getLogger()
    root.setLevel(level)

    # 清空既有 handler，避免重复配置
    for handler in list(root.handlers):
        root.removeHandler(handler)

    handler = logging.StreamHandler(stream=sys.stderr)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)


def get_logger(name: str, **context: Any) -> logging.LoggerAdapter[logging.Logger]:
    """获取带上下文（如 job_id）的 logger。"""

    return logging.LoggerAdapter(logging.getLogger(name), context)
