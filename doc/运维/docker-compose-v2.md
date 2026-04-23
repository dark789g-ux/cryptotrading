# docker compose v2 语法要求

## 背景

新版 Docker Desktop 不再附带独立的 `docker-compose`（v1）可执行文件，只内置 `docker compose`（v2，作为 docker 子命令）。

## 结论

所有脚本和配置必须使用 `docker compose`（空格），不能用 `docker-compose`（连字符）；`docker-compose.yml` 不需要写 `version` 字段。

## 详情

**错误写法（v1，Windows 新环境会报"命令不存在"）：**
```bash
docker-compose up -d postgres
```

**正确写法（v2）：**
```bash
docker compose up -d postgres
```

**package.json 中的正确写法：**
```json
"db:start": "docker compose up -d postgres",
"db:stop": "docker compose stop postgres",
"prod:up": "docker compose -f docker-compose.prod.yml up -d --build"
```

**docker-compose.yml 中去掉 version 字段：**
```yaml
# 不需要这行，新版会警告 "the attribute version is obsolete"
# version: '3.8'

services:
  postgres:
    ...
```
