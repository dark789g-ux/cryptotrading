"""POSIX 风格的 artifact 路径助手（spec 05-risks.md §6）。

约束：
- artifact_uri 入库必须 POSIX 风格 / 相对路径（`./artifacts/<uuid>/model.txt`），不存盘符
- 文件 I/O 仍走 `pathlib.Path`（让 Python 自己处理 Windows 反斜杠）
- 序列化时统一使用 `PurePosixPath`，前端下载链接由 NestJS 拼当前主机 base URL

调用方约定：
- training.runner / inference.runner 通过 `artifact_root() / artifact_dir(run_id) / artifact_uri(run_id, name)` 获得绝对/相对路径
- 入库 `ml.model_runs.artifact_uri` 写 POSIX 相对路径（带前导 `./`）
"""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath
from uuid import UUID


# 项目相对 artifact 根目录（POSIX 风格）
_ARTIFACT_ROOT_REL = PurePosixPath("./artifacts")


def artifact_root() -> Path:
    """返回 artifact 根目录绝对路径（Path 对象）。

    优先读 `ARTIFACT_DIR` 环境变量；未配置时使用 `cwd/artifacts`。
    返回值用于本地 I/O；序列化入库需要走 `artifact_uri`。
    """

    env = os.environ.get("ARTIFACT_DIR", "").strip()
    if env:
        return Path(env).resolve()
    return (Path.cwd() / "artifacts").resolve()


def artifact_dir(run_id: UUID | str) -> Path:
    """该 model_run_id 的本地 artifact 目录（Path，绝对路径）。"""

    return artifact_root() / str(run_id)


def artifact_uri(run_id: UUID | str, filename: str) -> str:
    """生成入库用的 POSIX 风格相对路径，如 `./artifacts/<uuid>/model.txt`。

    禁止包含盘符或反斜杠。保留前导 `./` 以明示相对路径（PurePosixPath 默认会把
    `./a/b` 规范化为 `a/b`，这里手工拼回前导 `./`）。
    """

    if "\\" in filename or filename.startswith("/"):
        raise ValueError(f"filename 必须为相对、POSIX 风格，got {filename!r}")
    # 用 PurePosixPath 拼接子路径再前置 './'，保留约定的"相对路径"形态
    rel = PurePosixPath("artifacts") / str(run_id) / filename
    return f"./{rel.as_posix()}"


def ensure_artifact_dir(run_id: UUID | str) -> Path:
    """创建并返回 artifact 目录。底层 mkdir 失败由调用方包装为 ArtifactWriteError。"""

    target = artifact_dir(run_id)
    target.mkdir(parents=True, exist_ok=True)
    return target
