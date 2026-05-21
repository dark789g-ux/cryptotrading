"""schema_contract 单元测试。"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from quant_pipeline.db.schema_contract import REQUIRED, validate_schema


class TestValidateSchema:
    """validate_schema 测试。"""

    @staticmethod
    def _mock_session(table_columns: list[tuple[str, str]]) -> MagicMock:
        """构造 mock session，返回指定的 (table, column) 行。"""
        session = MagicMock()
        result = MagicMock()
        result.fetchall.return_value = table_columns
        session.execute.return_value = result
        return session

    def test_all_present(self) -> None:
        """正向测试：完整 schema 不抛异常。"""
        rows = []
        for table, cols in REQUIRED.items():
            for col in cols:
                rows.append((table, col))
        session = self._mock_session(rows)
        validate_schema(session)  # 不抛异常

    def test_missing_table(self) -> None:
        """缺少整张表。"""
        rows = []
        for table, cols in REQUIRED.items():
            if table == "raw.suspend_d":
                continue
            for col in cols:
                rows.append((table, col))
        session = self._mock_session(rows)
        with pytest.raises(RuntimeError, match="缺失表: raw.suspend_d"):
            validate_schema(session)

    def test_missing_column(self) -> None:
        """表存在但缺列。"""
        rows = []
        for table, cols in REQUIRED.items():
            for col in cols:
                if table == "raw.suspend_d" and col == "trade_date":
                    continue
                rows.append((table, col))
        session = self._mock_session(rows)
        with pytest.raises(RuntimeError, match="缺失列: raw.suspend_d.trade_date"):
            validate_schema(session)

    def test_multiple_missing_reported_together(self) -> None:
        """多项缺失一次性报告。"""
        rows = []
        for table, cols in REQUIRED.items():
            for col in cols:
                if (table, col) in {("raw.suspend_d", "trade_date"), ("raw.daily_quote", "close")}:
                    continue
                rows.append((table, col))
        session = self._mock_session(rows)
        with pytest.raises(RuntimeError) as exc_info:
            validate_schema(session)
        msg = str(exc_info.value)
        assert "raw.suspend_d.trade_date" in msg
        assert "raw.daily_quote.close" in msg
