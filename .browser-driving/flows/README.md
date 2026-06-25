# flows/ — 固化的可重放测试流程

这里放**走通过一次、固化下来的完整测试流程**。目的：同一个任务下次**一步到位**直接跑，不用再
「走一步看一步」地逐步探索。探索是手段（见 `../scripts/serve.py` + `attach`），`flows/` 里的脚本是产物。

## 什么时候建一个 flow

在交互模式（`serve` 常驻浏览器 + 写 `.tmp/step.py` 逐步 attach）里把一条流程摸通、验证过之后，
把这条**经过验证的整条步骤**固化成 `flows/<任务>.py`。一次性的探索脚本留在 `.tmp/`（不入库）；
会反复用的流程才提到 `flows/`。

## 一个 flow 必须满足

1. **自包含可重放**：用 `argparse` 接 `--port`（默认 `config.cdpPort`），`attach(p, cfg, port)` 连常驻浏览器，
   **自己 `goto_route` 回到起点**——不依赖浏览器当前停在哪，否则重放结果随上次终态漂移。
   （`flows/` 是 `scripts/` 兄弟目录，须先 `sys.path.insert` 把 `scripts/` 加进来才能 `import _common`——
   `_template.py` 已自带这段引导，从模板 `cp` 即可，别手写漏掉。）
2. **关键步骤程序化断言**：用 `flow_assert(cond, step, expect, actual)`。断言失败统一报
   `FLOW_BROKEN @ step N: 期望 X 实际 Y`，一眼定位是哪个路径假设破了。
3. **跑完停终态不关**：结尾只 `browser.close()`（attach 模式下只断开 CDP、不杀常驻浏览器），
   浏览器留在终态供肉眼复核 / 继续操作。
4. **头部元信息**：见 `_template.py` —— 一句话目标、**上次验证日期**、**关键路径假设清单**（路由/选择器/接口）。
   这份清单就是「什么变了会让脚本断」的备忘，失效时照着它去交互模式重摸。

## 失效自愈（代码更新导致路径走不通）

flow 跑出 `FLOW_BROKEN @ step N` → 说明某个路径假设破了（路由改了 / 选择器变了 / 接口口径变了）：

1. 回交互模式（`serve` + `attach` + `.tmp/step.py`）逐步重摸那一段，找到新路径；
2. 修正本 flow 脚本对应步骤；
3. **更新头部**的「上次验证：YYYY-MM-DD」与「关键路径假设」；
4. 把**通用的** Playwright 经验追加到 `../lessons-learned.md`（某任务特有的路径细节留在本文件头部，别混进 lessons）。

## 与 `prompts/` 的区别

仓库根 `prompts/` 是给人/agent 读的**自然语言**跨会话交接；`flows/` 是**可执行**的固化流程脚本。互补。

## 起步

```bash
cp .browser-driving/flows/_template.py .browser-driving/flows/<任务>.py
# 编辑头部元信息 + 按真实步骤替换 step + flow_assert
# 先后台起 serve，再： python .browser-driving/flows/<任务>.py [--port N]
```
