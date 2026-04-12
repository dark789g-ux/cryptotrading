# CSV 迁移：close_time 时间戳解析错误

## 背景

执行 `pnpm migrate:csv` 时，所有 CSV 文件均被跳过，错误信息为：
```
invalid input syntax for type timestamp with time zone: "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN"
```

## 结论

CSV 中的 `close_time` 是毫秒级 Unix 时间戳字符串（如 `"1739750399999"`），必须先转为数字再传给 `new Date()`。

## 详情

**错误写法：**
```ts
closeTime: r.close_time ? new Date(r.close_time) : null,
// new Date("1739750399999") → Invalid Date（字符串不被识别为时间戳）
```

**正确写法：**
```ts
closeTime: r.close_time ? new Date(Number(r.close_time)) : null,
// new Date(1739750399999) → 正确解析为 UTC 时间
```

**位置：** `apps/server/src/migration/csv-import.ts` 第 101 行
