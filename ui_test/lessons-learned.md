# ui_test/lessons-learned.md

记录 WebBridge / 前端 UI 测试的通用踩坑经验。

格式：

```markdown
## 症状标题

- **Symptom**: 看到什么现象
- **Cause**: 根因
- **Lesson**: 以后怎么做
```

---

## WebBridge evaluate 需要先有 tab

- **Symptom**: `evaluate` 请求返回 502 / "session has no tab"
- **Cause**: `ensure_login` 在 `navigate` 之前调用，`evaluate` 需要当前 session 已有打开的标签页
- **Lesson**: `evaluate` / `click` / `fill` / `snapshot` 等单标签页工具要求 session 先通过 `navigate` 或 `find_tab` 建立当前标签页。登录检查函数应先 `navigate` 到任意页面再 `evaluate`

---

## 异步加载表格需要轮询等待

- **Symptom**: 表格元素已存在 (`document.querySelector('table') !== null`) 但 `tbody tr` 行数为 0
- **Cause**: 申万指数表格数据是异步加载的，DOM 中 `<table>` 骨架先渲染，数据行后填充
- **Lesson**: 验证表格加载时不能仅检查 `table` 存在，要轮询检查 `tbody tr` 行数 > 0，最多等待 10 秒

---

## Naive UI n-data-table 排序循环方向

- **Symptom**: 点击排序按钮后，不确定当前是升序还是降序
- **Cause**: Naive UI `n-data-table` 的排序循环为：无排序 → 点击 1 次 → **降序**（descend）→ 点击 2 次 → **升序**（ascend）→ 点击 3 次 → 无排序。与直觉相反，首次点击即降序
- **Lesson**: 需要"倒序/降序"时点击 1 次即可；需要"升序"时点击 2 次。验证排序方向应读取实际数据值，不要依赖类名（`--sorting` 在升序和降序时都出现）

---

## 申万指数表格定位应使用 data-testid

- **Symptom**: `document.querySelectorAll('table')[2]` 在页面刷新后失效，返回 undefined
- **Cause**: 直接导航到 `/symbols` 时页面只渲染 1 个 table（申万指数表格），而经过 A 股数据 → A 股指数 → 申万指数 的交互后页面可能有多个 table。table 索引不稳定
- **Lesson**: 优先使用组件声明的 `data-testid="a-shares-index-sw-table"` 选择器定位申万指数表格，不要依赖 `document.querySelectorAll('table')[N]` 的索引

---

## 三级申万指数筛选需等待异步加载

- **Symptom**: 点击"三级" radio button 后立即检查数据，发现仍然是 801xxx.SI（一级指数）
- **Cause**: `applyLevelFilter()` 触发后端异步请求，数据加载需要时间（约 1-2 秒）
- **Lesson**: 点击级别筛选后必须 `time.sleep(2)` 或轮询等待，直到 `tbody tr` 的代码变为 85xxxx.SI 格式（三级指数）

---

## 前端数值格式化导致排序验证复杂化

- **Symptom**: 验证降序时发现 "97462.25 万" 排在 "1.75 亿" 之后，看似排序错误
- **Cause**: 前端根据数值大小自动选择"亿"或"万"作为显示单位，但后端按原始数值排序是正确的。混合单位的显示顺序需要统一转换为同一单位才能验证
- **Lesson**: 验证排序时，将"亿"和"万"统一转换为"元"后再比较；或直接验证前 N 个同单位的数据是否降序，对跨单位边界放宽断言
