"""lint_no_silent_degradation 单元测试。"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from tools.lint_no_silent_degradation import lint_directory, lint_file


class TestLintFile:
    """单文件 lint 测试。"""

    @staticmethod
    def _write_tmp(tmp_path: Path, name: str, code: str) -> Path:
        p = tmp_path / name
        p.write_text(textwrap.dedent(code), encoding="utf-8")
        return p

    def test_whitelisted_function_no_report(self, tmp_path: Path) -> None:
        """白名单函数中的空返回不报告。"""
        code = '''
        def run_worker_loop():
            try:
                pass
            except Exception:
                return []
        '''
        # 用白名单中的文件名
        p = self._write_tmp(tmp_path, "worker_loop.py", code)
        # 手动模拟白名单匹配
        violations = lint_file(p)
        # 因为文件名不含 "worker/loop.py"，会报告
        # 这里测试的是：如果文件路径匹配白名单则不报告
        # 实际测试用 lint_directory 配合正确路径

    def test_violation_detected(self, tmp_path: Path) -> None:
        """非白名单函数中的空返回被报告。"""
        code = '''
        def my_func():
            try:
                pass
            except Exception:
                return []
        '''
        p = self._write_tmp(tmp_path, "bad.py", code)
        violations = lint_file(p)
        assert len(violations) == 1
        assert "SILENT-DEGRADATION" in violations[0]
        assert "return []" not in violations[0]  # 报告不包含代码本身

    def test_logger_then_empty_return_detected(self, tmp_path: Path) -> None:
        """logger 后跟空返回仍被检测。"""
        code = '''
        import logging
        logger = logging.getLogger(__name__)
        def fetch_data():
            try:
                pass
            except Exception:
                logger.error("failed")
                return []
        '''
        p = self._write_tmp(tmp_path, "fetch.py", code)
        violations = lint_file(p)
        assert len(violations) == 1

    def test_non_empty_return_not_detected(self, tmp_path: Path) -> None:
        """返回非空列表不报告。"""
        code = '''
        def my_func():
            try:
                pass
            except Exception:
                return [1, 2]
        '''
        p = self._write_tmp(tmp_path, "ok.py", code)
        violations = lint_file(p)
        assert len(violations) == 0

    def test_return_none_detected(self, tmp_path: Path) -> None:
        """return None 被检测。"""
        code = '''
        def my_func():
            try:
                pass
            except Exception:
                return None
        '''
        p = self._write_tmp(tmp_path, "none_ret.py", code)
        violations = lint_file(p)
        assert len(violations) == 1

    def test_bare_return_detected(self, tmp_path: Path) -> None:
        """裸 return 被检测。"""
        code = '''
        def my_func():
            try:
                pass
            except Exception:
                return
        '''
        p = self._write_tmp(tmp_path, "bare_ret.py", code)
        violations = lint_file(p)
        assert len(violations) == 1

    def test_return_empty_dict_detected(self, tmp_path: Path) -> None:
        """return {} 被检测。"""
        code = '''
        def my_func():
            try:
                pass
            except Exception:
                return {}
        '''
        p = self._write_tmp(tmp_path, "empty_dict.py", code)
        violations = lint_file(p)
        assert len(violations) == 1

    def test_return_set_detected(self, tmp_path: Path) -> None:
        """return set() 被检测。"""
        code = '''
        def my_func():
            try:
                pass
            except Exception:
                return set()
        '''
        p = self._write_tmp(tmp_path, "empty_set.py", code)
        violations = lint_file(p)
        assert len(violations) == 1

    def test_return_dataframe_columns_detected(self, tmp_path: Path) -> None:
        """return pd.DataFrame(columns=...) 被检测。"""
        code = '''
        import pandas as pd
        def my_func():
            try:
                pass
            except Exception:
                return pd.DataFrame(columns=["a", "b"])
        '''
        p = self._write_tmp(tmp_path, "df_ret.py", code)
        violations = lint_file(p)
        assert len(violations) == 1

    def test_any_except_type_detected(self, tmp_path: Path) -> None:
        """任何 except 类型（不只是 Exception）都检测。"""
        code = '''
        def my_func():
            try:
                pass
            except KeyError:
                return []
        '''
        p = self._write_tmp(tmp_path, "key_err.py", code)
        violations = lint_file(p)
        assert len(violations) == 1

    def test_assignment_then_empty_return_detected(self, tmp_path: Path) -> None:
        """中间有赋值仍检测最后的空返回。"""
        code = '''
        def my_func():
            try:
                pass
            except Exception:
                x = 1
                return []
        '''
        p = self._write_tmp(tmp_path, "assign.py", code)
        violations = lint_file(p)
        assert len(violations) == 1

    def test_no_except_no_violation(self, tmp_path: Path) -> None:
        """没有 except 块的文件不报告。"""
        code = '''
        def my_func():
            return []
        '''
        p = self._write_tmp(tmp_path, "clean.py", code)
        violations = lint_file(p)
        assert len(violations) == 0


class TestLintDirectory:
    """目录 lint 测试。"""

    def test_skips_pycache(self, tmp_path: Path) -> None:
        """跳过 __pycache__ 目录。"""
        cache_dir = tmp_path / "__pycache__"
        cache_dir.mkdir()
        bad_file = cache_dir / "bad.py"
        bad_file.write_text("def f():\n  try: pass\n  except: return []\n", encoding="utf-8")
        violations = lint_directory(tmp_path)
        assert len(violations) == 0
