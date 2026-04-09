---
name: html-report-with-kline
description: Generates HTML report interfaces with HTML + CSS, uses Python HTTP server to serve local files and APIs, and integrates K-line charts when needed. Use when building local report viewers, data dashboards, or HTML pages that load CSV/JSON from disk.
---

# HTML 报告界面与本地服务

生成 HTML + CSS 界面，通过 Python 脚本启动 HTTP 服务读取本地文件，需要 K 线图时参考 [generating-kline-charts](../generating-kline-charts/SKILL.md)。

## 技术栈

- **前端**：HTML + CSS（无框架，纯静态）
- **服务**：Python `http.server` 扩展，提供静态文件 + 自定义 API
- **图表**：K 线使用 ECharts candlestick，见 [generating-kline-charts](../generating-kline-charts/SKILL.md)

## 1. HTML 界面结构

### 基础模板

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>报告标题</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background:#f0f2f5; color:#333; }
  .container { max-width:1400px; margin:0 auto; padding:20px; }
  .card { background:#fff; border-radius:8px; padding:20px; box-shadow:0 2px 8px rgba(0,0,0,.08); }
  .chart-wrap { position:relative; height:320px; }
</style>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"></script>
</head>
<body>
  <div id="loading">⏳ 数据加载中…</div>
  <div class="container" id="mainContent" style="display:none">
    <!-- 内容区 -->
  </div>
  <script>
    fetch('/api/data').then(r => r.json()).then(data => {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('mainContent').style.display = 'block';
      render(data);
    }).catch(err => {
      document.getElementById('loading').innerHTML =
        '⚠ 无法加载数据。请通过 <code>python serve_report.py</code> 启动本地服务器。';
    });
  </script>
</body>
</html>
```

### 关键点

- 使用 `fetch()` 加载数据，**不能直接双击 HTML**（CORS 限制）
- 错误提示中明确告知用户需启动 Python 服务
- 图表容器使用 `flex: 1; min-height: 0` 避免 flex 子元素溢出

## 2. Python 本地服务脚本

### 配置（写在脚本顶部）

```python
# 配置
PORT = 8888
SERVE_DIR = Path(".")       # 静态文件根目录
DATA_DIR = Path("data")     # 数据文件目录（CSV/JSON）
```

### Handler 模式

继承 `http.server.SimpleHTTPRequestHandler`，在 `do_GET` 中拦截 API 路径：

```python
class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_DIR.resolve()), **kwargs)

    def do_GET(self) -> None:
        if self.path == "/api/data":
            self._serve_data()
        elif self.path == "/api/intervals":
            self._serve_intervals()
        elif self.path == "/api/strategies":
            self._serve_strategies()
        elif self.path.startswith("/api/symbols"):
            self._serve_symbols()
        elif self.path.startswith("/api/klines/"):
            self._serve_klines()
        else:
            super().do_GET()

    def _serve_json(self, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)
```

### K 线视图相关 API

| 路径 | 说明 |
|------|------|
| `GET /api/intervals` | 返回 `[{id, name}, ...]`，可用 K 线周期（1h/4h/1d） |
| `GET /api/strategies` | 返回 `[{id, name}, ...]`，供策略下拉填充，含 `id: ""` 表示「无」 |
| `GET /api/symbols?interval=1d&strategy=jdj_ma` | 返回标的列表，`strategy` 为空时返回全部 |
| `GET /api/klines/{interval}/{symbol}.csv` | 返回指定周期、标的的 K 线 CSV |

### 读取本地文件示例

```python
def _serve_data(self) -> None:
    path = DATA_DIR / "report.json"
    if not path.exists():
        self.send_error(404, "report.json not found")
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    self._serve_json(data)

def _serve_strategies(self) -> None:
    """返回策略列表。策略定义在 STRATEGIES 中，新增策略时追加并注册检查函数。"""
    # STRATEGIES = [{"id": "", "name": "无"}, {"id": "jdj_ma", "name": "KDJ超卖+均线多头"}, ...]
    self._serve_json(STRATEGIES)

def _serve_klines(self) -> None:
    # /api/klines/BTCUSDT.csv
    parts = self.path.split("/")
    if len(parts) < 4:
        self.send_error(400, "Missing symbol")
        return
    symbol = parts[-1].replace(".csv", "")
    path = DATA_DIR / "klines" / f"{symbol}.csv"
    if not path.exists():
        self.send_error(404, f"{symbol} not found")
        return
    # 返回 CSV 或转为 JSON
    ...
```

### 启动入口

```python
def main() -> None:
    url = f"http://localhost:{PORT}/report.html"
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), _Handler) as httpd:
        print(f"服务已启动 → {url}")
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已停止")
```

## 3. K 线图展示界面布局

### 3.1 左右分栏结构

```
┌─────────────────────────────────────────────────────────────────┐
│  筛选栏（周期 + 策略单选下拉 + 搜索/筛选）                          │
├──────────────────┬──────────────────────────────────────────────┤
│  标的列表        │  K 线图区域                                    │
│  （可滚动）      │  （ECharts 四格布局）                          │
│  - BTCUSDT       │  ┌──────────────────────────────────────────┐ │
│  - ETHUSDT       │  │ 主图：K线 + MA                            │ │
│  - ...           │  ├──────────────────────────────────────────┤ │
│                  │  │ MACD                                      │ │
│                  │  ├──────────────────────────────────────────┤ │
│                  │  │ KDJ                                       │ │
│                  │  ├──────────────────────────────────────────┤ │
│                  │  │ stop_loss / risk_reward                   │ │
│                  │  └──────────────────────────────────────────┘ │
└──────────────────┴──────────────────────────────────────────────┘
```

- **左侧**：固定宽度（建议 260–320px），标的列表 + 上方筛选栏
- **右侧**：`flex: 1` 占满剩余空间，K 线图容器 `flex: 1; min-height: 0`
- 点击标的列表某行时，右侧 K 线图切换为该标的，并高亮当前选中行

### 3.2 CSS 布局示例

```css
.kline-view { display: flex; height: calc(100vh - 60px); overflow: hidden; }
.kline-sidebar {
  width: 280px; flex-shrink: 0; display: flex; flex-direction: column;
  border-right: 1px solid #e0e6ef; background: #fff;
}
.kline-filter-bar {
  padding: 10px 12px; border-bottom: 1px solid #e8ecf0; flex-shrink: 0;
  display: flex; flex-direction: column; gap: 8px;
}
.kline-filter-row { display: flex; align-items: center; gap: 6px; }
.kline-filter-row label { font-size: .75rem; color: #7f8c8d; min-width: 42px; }
.kline-filter-row select, .kline-filter-row input {
  flex: 1; padding: 4px 8px; border: 1px solid #d5d8dc; border-radius: 4px; font-size: .82rem;
}
.kline-filter-row .filter-sep { color: #bbb; font-size: .8rem; }
.btn-reset { padding: 4px 10px; font-size: .78rem; border: 1px solid #d5d8dc; border-radius: 4px;
             background: #fff; color: #666; cursor: pointer; }
.btn-reset:hover { border-color: #e74c3c; color: #e74c3c; }
.kline-list { flex: 1; overflow-y: auto; }
.kline-chart-area { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.kline-chart-wrap { flex: 1; min-height: 0; }
.kline-list tr { cursor: pointer; }
.kline-list tr:hover { background: #f4f6f8; }
.kline-list tr.selected { background: #eaf4fd; border-left: 3px solid #3498db; }
```

### 3.3 筛选栏设计

筛选栏位于标的列表上方，包含：

| 组件 | 类型 | 说明 |
|------|------|------|
| **周期** | `<select>` 下拉 | 切换 K 线周期（1h/4h/1d），选项由 `/api/intervals` 或静态提供 |
| **策略** | `<select>` 单选下拉 | 切换标的筛选策略，选项由 `GET /api/strategies` 动态填充，首项为「无」 |
| **标的搜索** | `<input type="text">` | 按 symbol 模糊匹配，实时过滤列表 |
| **区间筛选** | `<input type="date">` 起止 | 可选，按时间范围过滤有信号的标的 |
| **重置** | 按钮 | 清空筛选条件 |

```html
<div class="kline-filter-bar">
  <div class="kline-filter-row">
    <label>周期</label>
    <select id="intervalSelect">
      <option value="1d">日线</option>
      <option value="4h">4 小时</option>
      <option value="1h">1 小时</option>
    </select>
  </div>
  <div class="kline-filter-row">
    <label>策略</label>
    <select id="strategySelect"></select>
  </div>
  <div class="kline-filter-row">
    <label>搜索</label>
    <input type="text" id="symbolSearch" placeholder="输入交易对…">
  </div>
  <div class="kline-filter-row">
    <label>区间</label>
    <input type="date" id="dateFrom"> <span class="filter-sep">–</span>
    <input type="date" id="dateTo">
  </div>
  <button type="button" class="btn-reset" id="btnReset">重置</button>
</div>
```

策略选项由 `GET /api/strategies` 返回 `[{id, name}, ...]`，前端 `initStrategySelect()` 动态填充，便于后续新增策略。详见 3.7 节。

### 3.4 标的列表与点击切换

- 列表列：symbol、策略名、信号时间、简要指标（如涨跌幅）等
- 行点击：`onclick` 或事件委托，调用 `loadKline(symbol)`，请求 `/api/klines/{symbol}.csv` 或 JSON，渲染右侧图表
- 选中态：`tr.selected` 或 `data-symbol` + 高亮当前行

```javascript
function onSymbolClick(ev, symbol) {
  document.querySelectorAll('.kline-list tr.selected').forEach(r => r.classList.remove('selected'));
  ev.currentTarget.classList.add('selected');
  loadKline(symbol);
}
// 行上：onclick="onSymbolClick(event, 'BTCUSDT')"
```

### 3.5 策略扩展约定

- 后端维护策略列表（`STRATEGIES` + `STRATEGY_CHECKERS`），`GET /api/strategies` 返回可选策略
- 前端 `#strategySelect` 的 `change` 事件触发 `loadSymbols()`，请求 `GET /api/symbols?interval=xxx&strategy=xxx`
- 新增策略时：后端添加策略配置并注册检查函数 → API 自动包含新选项，前端无需改 HTML
- 基于 K 线指标的策略实现详见 **3.7 标的策略筛选实现**

### 3.6 切换筛选时的 K 线联动（重要）

当存在**周期**（1h/4h/1d）、**策略**等会改变标的列表或数据源的筛选器时，切换筛选后 K 线图必须用新数据重新加载，否则会出现「切换周期/策略后 K 线图仍显示旧数据」的 BUG。

**实现要点：**

1. **记录当前选中标的**：用变量 `_currentSymbol` 保存当前点击的标的，在 `onSymbolClick` 中赋值。
2. **列表重渲染时恢复选中态**：`renderSymbolList` 中，若 `s.symbol === _currentSymbol`，为该行添加 `class="selected"`。
3. **筛选变更时重新加载 K 线**：
   - 筛选变更前保存 `symbolToReload = _currentSymbol`
   - 让 `loadSymbols()`（或等价函数）返回 Promise
   - 在 Promise 完成后，若 `symbolToReload` 仍在新列表中，调用 `loadKline(symbolToReload)` 用新筛选条件加载 K 线
   - 若该标的在新列表中不存在，则清空图表并显示占位提示，同时清空 `_currentSymbol`

```javascript
var _currentSymbol = null;

window.onSymbolClick = function(ev, symbol) {
  _currentSymbol = symbol;
  document.querySelectorAll('.kline-list tr.selected').forEach(r => r.classList.remove('selected'));
  ev.currentTarget.classList.add('selected');
  loadKline(symbol);
};

function renderSymbolList() {
  var html = _filteredSymbols.map(function(s) {
    var sel = s.symbol === _currentSymbol ? 'selected' : '';
    return '<tr data-symbol="' + s.symbol + '" class="' + sel + '" onclick="onSymbolClick(event, \'' + s.symbol + '\')">...</tr>';
  }).join('');
  // ...
}

function onIntervalChange() {  // 或 onStrategyChange
  _currentInterval = document.getElementById('intervalSelect').value;
  var symbolToReload = _currentSymbol;
  loadSymbols().then(function() {
    if (symbolToReload && _filteredSymbols.some(function(s) { return s.symbol === symbolToReload; })) {
      loadKline(symbolToReload);
    } else if (symbolToReload) {
      _currentSymbol = null;
      document.getElementById('chartPlaceholder').textContent = '点击左侧标的加载 K 线图';
      document.getElementById('klineChartWrap').style.display = 'none';
    }
  });
}
```

**API 约定**：若支持多周期，K 线接口需包含 interval 参数，如 `GET /api/klines/{interval}/{symbol}.csv`。

### 3.7 标的策略筛选实现（基于 K 线指标）

当策略需要根据**最后一根 K 线的指标**筛选标的时（如 KDJ.J、MA、收盘价等），后端需读取每个标的的 CSV，检查最后一行的条件。

#### 策略字段：单选下拉框

策略选择使用 **`<select>` 单选下拉框**，便于后续扩展多种策略：

```html
<div class="kline-filter-row">
  <label>策略</label>
  <select id="strategySelect"></select>
</div>
```

选项由 `GET /api/strategies` 动态填充，首项为 `id: ""`、`name: "无"` 表示不筛选。

#### 后端实现要点

1. **策略列表**：`STRATEGIES = [{"id": "", "name": "无"}, {"id": "jdj_ma", "name": "KDJ超卖+均线多头"}, ...]`
2. **策略检查函数**：每个策略对应一个 `(path: Path) -> bool` 函数，读取 CSV 最后一行的指标并判断
3. **策略注册表**：`STRATEGY_CHECKERS = {"jdj_ma": _check_strategy_jdj_ma}`，便于扩展
4. **多线程**：使用 `ThreadPoolExecutor` 并行读取多个标的的 CSV，提升筛选速度

```python
# 策略检查示例：最后一根 K 线满足 KDJ.J<10, 收盘>MA60, MA30>MA60, MA60>MA120
def _check_strategy_jdj_ma(path: Path) -> bool:
    df = pd.read_csv(path, encoding="utf-8-sig")
    if df.empty:
        return False
    row = df.iloc[-1]
    j = pd.to_numeric(row.get("KDJ.J"), errors="coerce")
    close = pd.to_numeric(row.get("close"), errors="coerce")
    ma30 = pd.to_numeric(row.get("MA30"), errors="coerce")
    ma60 = pd.to_numeric(row.get("MA60"), errors="coerce")
    ma120 = pd.to_numeric(row.get("MA120"), errors="coerce")
    if pd.isna(j) or pd.isna(close) or pd.isna(ma30) or pd.isna(ma60) or pd.isna(ma120):
        return False
    return j < 10 and close > ma60 and ma30 > ma60 and ma60 > ma120

STRATEGY_CHECKERS = {"jdj_ma": _check_strategy_jdj_ma}
```

#### 前端实现要点

1. **初始化**：`fetchStrategies()` 获取策略列表，`initStrategySelect(strategies)` 填充下拉框
2. **请求标的**：`fetchSymbols(interval, strategy)`，`strategy` 为空时请求全部
3. **策略变更**：`strategySelect` 的 `change` 事件触发 `loadSymbols()`，若当前选中标的不在新列表中则清空图表

```javascript
function fetchStrategies() {
  return fetch('/api/strategies').then(r => r.json());
}
function initStrategySelect(strategies) {
  var sel = document.getElementById('strategySelect');
  sel.innerHTML = strategies.map(s =>
    '<option value="' + (s.id || '') + '">' + (s.name || '') + '</option>'
  ).join('');
}
function fetchSymbols(interval, strategy) {
  var url = '/api/symbols?interval=' + encodeURIComponent(interval);
  if (strategy) url += '&strategy=' + encodeURIComponent(strategy);
  return fetch(url).then(r => r.json());
}
```

#### 新增策略步骤

1. 在 `STRATEGIES` 中追加 `{"id": "新策略id", "name": "显示名称"}`
2. 实现检查函数 `_check_strategy_xxx(path) -> bool`
3. 在 `STRATEGY_CHECKERS` 中注册 `"新策略id": _check_strategy_xxx`

前端无需修改，新策略会自动出现在下拉框中。

## 4. K 线图集成

当报告需要 K 线图时，遵循 [generating-kline-charts](../generating-kline-charts/SKILL.md)：

- 使用 ECharts `candlestick` 类型
- 数据格式 `[open, close, low, high]`
- 四格布局：主图 + MACD + KDJ + stop_loss_pct/risk_reward_ratio
- 涨红跌绿、DataZoom、响应式 resize

项目内 `report.html` 含完整实现，可作为参考。

## 5. 脚本规范

- 配置写在脚本顶部，不用 `argparse`
- 使用 `Path` 处理路径，避免 Windows 反斜杠
- 输出 UTF-8，避免 stdout 乱码：`sys.stdout.reconfigure(encoding="utf-8")`（Python 3.7+）

## 6. 工具脚本

技能内提供通用模板脚本：

**scripts/serve_local.py**：从配置目录启动服务，`GET /api/data` 返回本地 JSON

```powershell
# 在项目根目录运行，修改脚本内 PORT、SERVE_DIR、DATA_FILE 等配置
python .cursor/skills/html-report-with-kline/scripts/serve_local.py
```

复制到项目根目录并修改配置后使用更佳。

## 7. 项目内参考

| 文件 | 说明 |
|------|------|
| `serve_report.py` | 本地报告服务，`/api/runs` 扫描回测目录 |
| `report.html` | 完整报告页：净值曲线、K 线、交易表等 |
| `serve_symbols.py` | 标的数据服务：多周期、策略筛选（STRATEGIES + STRATEGY_CHECKERS）、`/api/strategies` |
| `symbols.html` | 标的展示页：周期 + 策略单选下拉、标的列表、K 线图联动（含 3.6、3.7 节实现） |
| `.cursor/skills/generating-kline-charts/SKILL.md` | K 线图规范 |

## 快速启动

```powershell
python serve_report.py
```

浏览器自动打开 `http://localhost:8888/report.html`。
