"""
从币安 REST API 获取所有交易对信息，并将结果缓存到本地 CSV 文件。
缓存有效期默认为 1 小时，未过期时直接读取缓存，避免频繁请求。

仅缓存 status=TRADING 且 quoteAsset=USDT 的交易对。

CSV 列说明：
  - server_time   : 币安服务器时间戳（毫秒）
  - fetched_at    : 本地拉取时间（UTC ISO 格式）
  - 其余列        : symbols 数组中每个交易对的字段
  - 数组类型字段  : 以 JSON 字符串形式存储（如 orderTypes、permissionSets）
"""

import csv
import json
import time
import logging
import requests
from pathlib import Path
from datetime import datetime

# ══════════════════════════════════════════════════════════════
#  运行配置（直接修改此处变量来控制脚本行为）
# ══════════════════════════════════════════════════════════════

# 是否强制忽略缓存，重新从 API 拉取数据
FORCE_REFRESH: bool = False

# 额外导出文件路径（None 表示不导出）；例如："exports/usdt_symbols.csv"
OUTPUT_FILE: str | None = None

# ──────────────────────────── 内部配置 ────────────────────────────
BASE_URL = "https://api.binance.com"
EXCHANGE_INFO_ENDPOINT = "/api/v3/exchangeInfo"

CACHE_DIR = Path(__file__).parent / "cache"
CACHE_FILE = CACHE_DIR / "exchange_info.csv"
CACHE_TTL_SECONDS = 3600  # 缓存有效期：1 小时

# CSV 中需要保留的交易对字段（数组字段以 JSON 字符串存储）
SYMBOL_FIELDS = [
    "symbol", "status", "baseAsset", "baseAssetPrecision",
    "quoteAsset", "quotePrecision", "quoteAssetPrecision",
    "baseCommissionPrecision", "quoteCommissionPrecision",
    "orderTypes",                  # list → JSON 字符串
    "icebergAllowed", "ocoAllowed", "otoAllowed", "opoAllowed",
    "quoteOrderQtyMarketAllowed", "allowTrailingStop",
    "cancelReplaceAllowed", "isSpotTradingAllowed", "isMarginTradingAllowed",
    "permissionSets",              # nested list → JSON 字符串
    "defaultSelfTradePreventionMode",
]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


# ──────────────────────────── 缓存工具 ────────────────────────────
def _is_cache_valid() -> bool:
    """判断缓存文件是否存在且未过期。"""
    if not CACHE_FILE.exists():
        return False
    age = time.time() - CACHE_FILE.stat().st_mtime
    return age < CACHE_TTL_SECONDS


def _save_cache(data: dict) -> None:
    """将 exchangeInfo 数据展平后写入 CSV 缓存文件。"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    server_time = data.get("serverTime", "")
    fetched_at = data.get("_fetched_at", "")
    symbols = [
        s for s in data.get("symbols", [])
        if s.get("status") == "TRADING" and s.get("quoteAsset") == "USDT"
    ]

    fieldnames = ["server_time", "fetched_at"] + SYMBOL_FIELDS

    with CACHE_FILE.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for s in symbols:
            row = {"server_time": server_time, "fetched_at": fetched_at}
            for field in SYMBOL_FIELDS:
                val = s.get(field, "")
                # 数组 / 嵌套结构序列化为 JSON 字符串
                if isinstance(val, (list, dict)):
                    val = json.dumps(val, ensure_ascii=False)
                row[field] = val
            writer.writerow(row)

    logger.info("缓存已保存至 %s（共 %d 条交易对）", CACHE_FILE, len(symbols))


def _load_cache() -> dict:
    """从 CSV 缓存文件还原为与 API 响应兼容的 dict。"""
    with CACHE_FILE.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    if not rows:
        return {"serverTime": "", "_fetched_at": "", "symbols": []}

    server_time = rows[0].get("server_time", "")
    fetched_at = rows[0].get("fetched_at", "")

    # 将数字/布尔/JSON 字段还原为原始类型
    _bool_fields = {
        "icebergAllowed", "ocoAllowed", "otoAllowed", "opoAllowed",
        "quoteOrderQtyMarketAllowed", "allowTrailingStop",
        "cancelReplaceAllowed", "isSpotTradingAllowed", "isMarginTradingAllowed",
    }
    _int_fields = {
        "baseAssetPrecision", "quotePrecision", "quoteAssetPrecision",
        "baseCommissionPrecision", "quoteCommissionPrecision",
    }
    _json_fields = {"orderTypes", "permissionSets"}

    symbols = []
    for row in rows:
        s = {}
        for field in SYMBOL_FIELDS:
            val = row.get(field, "")
            if field in _bool_fields:
                val = val.strip().lower() == "true"
            elif field in _int_fields:
                val = int(val) if val else 0
            elif field in _json_fields:
                val = json.loads(val) if val else []
            s[field] = val
        symbols.append(s)

    return {
        "serverTime": int(server_time) if server_time else 0,
        "_fetched_at": fetched_at,
        "symbols": symbols,
    }


# ──────────────────────────── 请求 ────────────────────────────
def _safe_get(url: str, max_retries: int = 5) -> requests.Response:
    """带 429/418 处理与指数退避的 GET 请求。"""
    for attempt in range(max_retries):
        resp = requests.get(url, timeout=15)

        used_weight = int(resp.headers.get("X-MBX-USED-WEIGHT-1M", 0))
        if used_weight > 1000:
            logger.warning("已用权重 %d，接近上限，主动降速 2 秒", used_weight)
            time.sleep(2)

        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 2 ** attempt))
            logger.warning("触发限速 (429)，等待 %d 秒后重试（第 %d 次）", wait, attempt + 1)
            time.sleep(wait)
            continue

        if resp.status_code == 418:
            wait = int(resp.headers.get("Retry-After", 300))
            raise RuntimeError(f"IP 已被封禁 (418)，需等待 {wait} 秒")

        resp.raise_for_status()
        return resp

    raise RuntimeError(f"请求失败，已重试 {max_retries} 次：{url}")


def fetch_exchange_info() -> dict:
    """调用币安 /api/v3/exchangeInfo 接口获取原始数据。"""
    url = BASE_URL + EXCHANGE_INFO_ENDPOINT
    logger.info("正在请求 %s ...", url)
    resp = _safe_get(url)
    data = resp.json()
    data["_fetched_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    return data


# ──────────────────────────── 主逻辑 ────────────────────────────
def get_exchange_info(force_refresh: bool = False) -> dict:
    """
    获取交易规范信息。
    优先读取有效缓存；缓存失效或 force_refresh=True 时重新拉取。
    """
    if not force_refresh and _is_cache_valid():
        logger.info("命中缓存（有效期 %d 秒），直接读取 %s", CACHE_TTL_SECONDS, CACHE_FILE)
        return _load_cache()

    data = fetch_exchange_info()
    _save_cache(data)
    return data


def extract_symbols(data: dict, status: str = "TRADING") -> list[dict]:
    """
    从 exchangeInfo 数据中提取交易对列表。

    参数：
        data   - get_exchange_info() 返回的完整数据
        status - 过滤交易状态，默认只保留 TRADING 状态；传 None 则返回全部

    返回：每个元素包含 symbol / baseAsset / quoteAsset / status 等关键字段。
    """
    symbols = data.get("symbols", [])
    result = []
    for s in symbols:
        if status and s.get("status") != status:
            continue
        result.append(
            {
                "symbol": s["symbol"],
                "baseAsset": s["baseAsset"],
                "quoteAsset": s["quoteAsset"],
                "status": s["status"],
                "isSpotTradingAllowed": s.get("isSpotTradingAllowed", False),
                "isMarginTradingAllowed": s.get("isMarginTradingAllowed", False),
            }
        )
    return result


# ──────────────────────────── 入口 ────────────────────────────
if __name__ == "__main__":
    data = get_exchange_info(force_refresh=FORCE_REFRESH)
    symbols = extract_symbols(data)

    # ── 打印摘要 ──
    server_time = data.get("serverTime", "N/A")
    fetched_at = data.get("_fetched_at", "N/A")
    print(f"\n{'='*55}")
    print(f"  服务器时间  : {server_time}")
    print(f"  数据拉取时间: {fetched_at}")
    print(f"  交易对数量  : {len(symbols)}")
    print(f"{'='*55}")

    for s in symbols[:20]:
        spot = "Y" if s["isSpotTradingAllowed"] else "N"
        margin = "Y" if s["isMarginTradingAllowed"] else "N"
        print(
            f"  {s['symbol']:<16} 状态:{s['status']:<8} "
            f"现货:{spot}  杠杆:{margin}"
        )
    if len(symbols) > 20:
        print(f"  ... 共 {len(symbols)} 条，以上仅展示前 20 条")

    # ── 可选导出 ──
    if OUTPUT_FILE:
        out_path = Path(OUTPUT_FILE)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        fieldnames = list(symbols[0].keys()) if symbols else []
        with out_path.open("w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(symbols)
        logger.info("交易对列表已导出至 %s", out_path)
