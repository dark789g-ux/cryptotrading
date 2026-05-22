"""schema_contract 单元测试。"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from quant_pipeline.db.schema_contract import (
    REQUIRED,
    TIMESTAMPTZ_COLUMNS,
    validate_schema,
)


def _data_type_for(table: str, col: str) -> str:
    """为 (table, col) 返回一个契约合法的 data_type。"""
    if col in TIMESTAMPTZ_COLUMNS.get(table, set()):
        return "timestamp with time zone"
    return "text"


class TestValidateSchema:
    """validate_schema 测试。"""

    @staticmethod
    def _mock_session(table_columns: list[tuple[str, str, str]]) -> MagicMock:
        """构造 mock session，返回指定的 (table, column, data_type) 行。"""
        session = MagicMock()
        result = MagicMock()
        result.fetchall.return_value = table_columns
        session.execute.return_value = result
        return session

    @staticmethod
    def _all_rows(
        skip_tables: set[str] | None = None,
        skip_cols: set[tuple[str, str]] | None = None,
    ) -> list[tuple[str, str, str]]:
        skip_tables = skip_tables or set()
        skip_cols = skip_cols or set()
        rows: list[tuple[str, str, str]] = []
        for table, cols in REQUIRED.items():
            if table in skip_tables:
                continue
            for col in cols:
                if (table, col) in skip_cols:
                    continue
                rows.append((table, col, _data_type_for(table, col)))
        return rows

    def test_all_present(self) -> None:
        """正向测试：完整 schema 不抛异常。"""
        session = self._mock_session(self._all_rows())
        validate_schema(session)  # 不抛异常

    def test_missing_table(self) -> None:
        """缺少整张表。"""
        session = self._mock_session(self._all_rows(skip_tables={"raw.suspend_d"}))
        with pytest.raises(RuntimeError, match="缺失表: raw.suspend_d"):
            validate_schema(session)

    def test_missing_column(self) -> None:
        """表存在但缺列。"""
        session = self._mock_session(
            self._all_rows(skip_cols={("raw.suspend_d", "trade_date")})
        )
        with pytest.raises(RuntimeError, match="缺失列: raw.suspend_d.trade_date"):
            validate_schema(session)

    def test_multiple_missing_reported_together(self) -> None:
        """多项缺失一次性报告。"""
        session = self._mock_session(
            self._all_rows(
                skip_cols={
                    ("raw.suspend_d", "trade_date"),
                    ("raw.daily_quote", "close"),
                }
            )
        )
        with pytest.raises(RuntimeError) as exc_info:
            validate_schema(session)
        msg = str(exc_info.value)
        assert "raw.suspend_d.trade_date" in msg
        assert "raw.daily_quote.close" in msg

    def test_timestamptz_column_wrong_type(self) -> None:
        """时间列被误建为无 TZ 的 timestamp 时校验失败（问题 5）。"""
        rows: list[tuple[str, str, str]] = []
        for table, cols in REQUIRED.items():
            for col in cols:
                dt = _data_type_for(table, col)
                if table == "ml.jobs" and col == "heartbeat_at":
                    dt = "timestamp without time zone"
                rows.append((table, col, dt))
        session = self._mock_session(rows)
        with pytest.raises(RuntimeError) as exc_info:
            validate_schema(session)
        msg = str(exc_info.value)
        assert "ml.jobs.heartbeat_at" in msg
        assert "timestamp with time zone" in msg
