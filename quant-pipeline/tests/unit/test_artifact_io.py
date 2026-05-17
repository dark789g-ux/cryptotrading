"""artifact I/O 单测（M2 Part G）：写盘失败 → ArtifactWriteError + 半成品清理。"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from quant_pipeline.training import runner as runner_mod
from quant_pipeline.training.runner import ArtifactWriteError, _write_artifact
from quant_pipeline.utils import paths as paths_mod


def test_artifact_uri_is_posix_relative() -> None:
    run_id = "abc-123"
    uri = paths_mod.artifact_uri(run_id, "model.txt")
    assert uri == "./artifacts/abc-123/model.txt"
    assert "\\" not in uri
    assert not uri.startswith("/")
    # 盘符禁止
    assert ":" not in uri


def test_artifact_uri_rejects_absolute() -> None:
    with pytest.raises(ValueError):
        paths_mod.artifact_uri("abc", "/etc/passwd")


def test_artifact_uri_rejects_backslash() -> None:
    with pytest.raises(ValueError):
        paths_mod.artifact_uri("abc", "sub\\model.txt")


def test_write_artifact_success(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """正常写盘：model.txt + meta.json 都落地。"""

    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))

    class _StubBooster:
        def save_model(self, path: str) -> None:
            Path(path).write_text("tree=0\n", encoding="utf-8")

    run_id = uuid4()
    model_uri, meta_uri = _write_artifact(run_id, _StubBooster(), {"hello": "world"})

    # URI 是 POSIX
    assert model_uri.startswith("./artifacts/")
    assert model_uri.endswith("/model.txt")
    assert meta_uri.endswith("/meta.json")

    # 实际文件存在
    model_path = tmp_path / str(run_id) / "model.txt"
    meta_path = tmp_path / str(run_id) / "meta.json"
    assert model_path.exists()
    assert meta_path.exists()
    assert "hello" in meta_path.read_text(encoding="utf-8")


def test_write_artifact_save_model_failure_cleans_up(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """save_model 抛错 → ArtifactWriteError + 半成品目录被清理。"""

    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))

    class _BrokenBooster:
        def save_model(self, path: str) -> None:
            raise OSError("disk full")

    run_id = uuid4()
    with pytest.raises(ArtifactWriteError, match="写盘失败"):
        _write_artifact(run_id, _BrokenBooster(), {})

    # 半成品目录应已清理
    assert not (tmp_path / str(run_id)).exists(), "半成品目录未清理"


def test_write_artifact_meta_write_failure_cleans_up(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """meta.json 写失败 → ArtifactWriteError + 清理目录（含已写的 model.txt）。"""

    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))

    class _StubBooster:
        def save_model(self, path: str) -> None:
            Path(path).write_text("ok", encoding="utf-8")

    # 让 meta 不可序列化
    class _NotJsonable:
        pass

    run_id = uuid4()
    with pytest.raises(ArtifactWriteError):
        _write_artifact(run_id, _StubBooster(), {"bad": _NotJsonable()})

    assert not (tmp_path / str(run_id)).exists(), "失败后目录应被清理"


def test_write_artifact_mkdir_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """ensure_artifact_dir 抛 OSError → ArtifactWriteError。"""

    def _fail_mkdir(_run_id: Any) -> Path:
        raise OSError("permission denied")

    monkeypatch.setattr(runner_mod, "ensure_artifact_dir", _fail_mkdir)

    class _StubBooster:
        def save_model(self, path: str) -> None:
            Path(path).write_text("ok", encoding="utf-8")

    with pytest.raises(ArtifactWriteError, match="无法创建"):
        _write_artifact(uuid4(), _StubBooster(), {})


def test_resolve_artifact_local_path_strips_dot_artifacts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """./artifacts/<uuid>/model.txt → <ARTIFACT_DIR>/<uuid>/model.txt。

    spec Part B 重构：解析逻辑迁到 inference.runner（与 predict_one_day 同模块），
    避免 score_writer 承担"路径还原"职责。
    """

    from quant_pipeline.inference.runner import _resolve_artifact_local_path

    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))
    p = _resolve_artifact_local_path("./artifacts/abc-123/model.txt")
    expected = tmp_path / "abc-123" / "model.txt"
    assert p == expected.resolve() or p == expected
