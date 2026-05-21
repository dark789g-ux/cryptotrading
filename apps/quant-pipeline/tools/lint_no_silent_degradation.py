"""AST lint：检测 except 块中静默返回空值的反模式。

用法：uv run lint-no-silent-degradation src/
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

# 白名单：(文件路径子串, 函数名) — 这些函数的空返回是设计如此
_WHITELIST: set[tuple[str, str]] = {
    ("worker/loop.py", "run_worker_loop"),
    ("worker/dispatcher.py", "dispatch"),
    ("sync/orchestrator.py", "run_sync_tables"),
    ("factors/runner.py", "run_factors"),
    ("quality/runner.py", "run_quality"),
    ("quality/checks_row.py", "check_duplicate_pk"),
    ("quality/checks_value.py", "check_null_violation"),
    ("quality/pit_audit.py", "run_ghost2_sample"),
    ("quality/pit_audit.py", "run_ghost3_sample"),
    ("inference/runner.py", "run_inference"),
    ("evaluation/shap_explainer.py", "explain"),
    ("evaluation/shap_explainer.py", "_write_fallback_report"),
    ("evaluation/shap_explainer.py", "safely_explain_after_train"),
    ("sync/stk_limit.py", "_to_float"),
    ("evaluation/ab_compare.py", "_run_single_fold"),
    ("training/walk_forward_runner.py", "_generate_report"),
    ("training/runner.py", "_run_shap_post_train"),
    ("training/tuning.py", "_optuna_progress_callback"),
    ("training/seed_averaging.py", "run_seed_averaging"),
}


def _is_dataframe_call(call_node: ast.Call) -> bool:
    """识别 pd.DataFrame(columns=...) 或 DataFrame(columns=...)。"""
    func = call_node.func
    name = None
    if isinstance(func, ast.Attribute) and func.attr == "DataFrame":
        name = func.value.id if isinstance(func.value, ast.Name) else None
    elif isinstance(func, ast.Name) and func.id == "DataFrame":
        name = "DataFrame"
    if name not in ("pd", "DataFrame"):
        return False
    return any(kw.arg == "columns" for kw in call_node.keywords)


def _returns_empty(node: ast.stmt) -> bool:
    """判断 return 语句是否返回空值/空容器。"""
    if not isinstance(node, ast.Return):
        return False
    val = node.value
    # 裸 return / return None
    if val is None:
        return True
    if isinstance(val, ast.Constant) and val.value is None:
        return True
    # return []（空列表字面量）
    if isinstance(val, ast.List) and len(val.elts) == 0:
        return True
    # return {}（空字典字面量）
    if isinstance(val, ast.Dict) and len(val.keys) == 0:
        return True
    # return set()
    if (
        isinstance(val, ast.Call)
        and isinstance(val.func, ast.Name)
        and val.func.id == "set"
        and len(val.args) == 0
    ):
        return True
    # return pd.DataFrame(columns=...) / return DataFrame(columns=...)
    if isinstance(val, ast.Call) and _is_dataframe_call(val):
        return True
    return False


def _find_parent_function(node: ast.AST, tree: ast.Module) -> str | None:
    """在 AST 中向上查找 node 所属的 FunctionDef，返回函数名。"""
    # 简单策略：遍历所有 FunctionDef，检查 node 是否在其 body 中
    # 用 line number 判断
    if not hasattr(node, "lineno"):
        return None
    target_line = node.lineno
    for parent in ast.walk(tree):
        if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # 检查目标行是否在此函数的范围内
            if hasattr(parent, "end_lineno") and parent.end_lineno is not None:
                if parent.lineno <= target_line <= parent.end_lineno:
                    return parent.name
    return None


def _is_whitelisted(file_path: str, func_name: str) -> bool:
    """检查 (文件路径, 函数名) 是否在白名单中。"""
    normalized = file_path.replace("\\", "/")
    for path_substring, whitelisted_func in _WHITELIST:
        if path_substring in normalized and func_name == whitelisted_func:
            return True
    return False


def lint_file(file_path: Path) -> list[str]:
    """检查单个 .py 文件，返回违规报告列表。"""
    try:
        source = file_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []

    try:
        tree = ast.parse(source, filename=str(file_path))
    except SyntaxError:
        return []

    violations: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ExceptHandler):
            continue

        # 取 except 块 body 的最后一条语句
        if not node.body:
            continue
        last_stmt = node.body[-1]

        if not _returns_empty(last_stmt):
            continue

        # 找所属函数
        func_name = _find_parent_function(node, tree)
        if func_name is not None and _is_whitelisted(str(file_path), func_name):
            continue

        # 报告违规
        line = last_stmt.lineno
        func_info = f" in {func_name}()" if func_name else ""
        violations.append(
            f"{file_path}:{line}: SILENT-DEGRADATION: "
            f"except 块静默返回空值{func_info}"
        )

    return violations


def lint_directory(dir_path: Path) -> list[str]:
    """递归扫描目录下所有 .py 文件。"""
    all_violations: list[str] = []
    for py_file in sorted(dir_path.rglob("*.py")):
        # 跳过 __pycache__ 和 .venv
        parts = py_file.parts
        if "__pycache__" in parts or ".venv" in parts or ".git" in parts:
            continue
        all_violations.extend(lint_file(py_file))
    return all_violations


def main() -> None:
    """CLI 入口。"""
    if len(sys.argv) < 2:
        print("用法: lint-no-silent-degradation <目录或文件>", file=sys.stderr)
        sys.exit(1)

    target = Path(sys.argv[1])
    if target.is_file():
        violations = lint_file(target)
    elif target.is_dir():
        violations = lint_directory(target)
    else:
        print(f"路径不存在: {target}", file=sys.stderr)
        sys.exit(1)

    for v in violations:
        print(v)

    if violations:
        print(f"\n共 {len(violations)} 处静默降级违规", file=sys.stderr)
        sys.exit(1)
    else:
        print("未发现静默降级违规")
        sys.exit(0)


if __name__ == "__main__":
    main()
