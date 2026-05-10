# -*- coding: utf-8 -*-
"""
择时模块主运行脚本
执行完整择时流程并输出当前信号

用法:
    python run_timing.py
    python run_timing.py --verbose   # 输出 JSON 格式结构化结果
"""

import sys
import os
# 将项目根目录加入 path，确保 timing 包可被导入
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import json
from timing.signal_engine import SignalEngine


def main():
    verbose = "--verbose" in sys.argv or "-v" in sys.argv
    use_active_mv = "--active-mv" in sys.argv

    print("=" * 50)
    print("  A股择时模块 - 运行中...")
    print("=" * 50)

    engine = SignalEngine(use_active_mv=use_active_mv)

    if verbose:
        result = engine.run_verbose()
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        result = engine.run()
        print(result)

    print("\n[INFO] 择时信号生成完成")

    # 返回 exit code：强多头/多头返回 0，中性返回 1，空头/强空头返回 2
    # 方便 shell 脚本做后续分支
    signal = result.overall if not verbose else result.get("signal")
    if signal in ("强多头", "多头"):
        return 0
    elif signal == "中性":
        return 1
    else:
        return 2


if __name__ == "__main__":
    sys.exit(main())
