# -*- coding: utf-8 -*-
"""生成1-66的不重复随机整数，按回车继续"""

import random

# 配置参数
MIN_NUM: int = 1
MAX_NUM: int = 8


def generate_unique_randoms(min_num: int, max_num: int):
    """生成不重复的随机数序列"""
    numbers = list(range(min_num, max_num + 1))
    random.shuffle(numbers)
    for num in numbers:
        yield num


def main():
    print(f"按回车生成 {MIN_NUM}-{MAX_NUM} 的不重复随机数，输入 q 退出")
    print("-" * 40)

    generator = generate_unique_randoms(MIN_NUM, MAX_NUM)
    generated_count = 0
    total = MAX_NUM - MIN_NUM + 1

    try:
        for num in generator:
            user_input = input(f"[{generated_count + 1}/{total}] 按回车继续... ")
            if user_input.lower() == 'q':
                print("已退出")
                break
            print(f"随机数: {num}")
            generated_count += 1
    except StopIteration:
        print("-" * 40)
        print(f"所有 {total} 个随机数已生成完毕！")


if __name__ == "__main__":
    main()
