# 场景：单表结构（psql \d）

## Purpose

按需查看真库列定义、索引、约束。表结构**不在 doc/db 中维护**，此为标准查结构方式。

## Tables & Columns

- 任意 `<schema>.<table>`

## Example SQL

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d raw.daily_quote"
```

等价 information_schema 查询：

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'raw' AND table_name = 'daily_quote'
ORDER BY ordinal_position;
```

## Pitfalls

- PowerShell 中 `\d` 需放在双引号内 `-c "\d schema.table"`。
- 分区表 `\d` 父表会列出子分区；查列定义通常看父表即可。
- 也可查 TypeORM entity：`apps/server/src/entities/<domain>/`。
