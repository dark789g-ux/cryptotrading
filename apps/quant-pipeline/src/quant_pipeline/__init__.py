"""quant_pipeline：A 股截面选股量化管道。

M0 阶段仅落 config / db / worker / cli 四个模块的实际代码，
其余模块（factors / labels / strategy / features / training /
evaluation / inference / quality / sync / utils）只保留空骨架。
"""

__version__ = "0.1.0"
