# Docker Desktop "Bad response from Docker engine"

## 背景

在 Windows 上使用旧版 Docker Desktop（v4.19.0）时，执行任何 `docker` 命令都报错，尽管 Docker Desktop 界面显示 "Engine running"。

## 结论

Docker Desktop v4.19.0 存在引擎通信 bug，必须升级到新版（v4.68.0+）才能正常使用。

## 详情

**现象：**
```
Error response from daemon: Bad response from Docker engine
```

即使 Docker Desktop 显示绿色 "Engine running"，`docker ps`、`docker info` 等命令均失败。

**根因：** v4.19.0 的引擎 API 与 CLI 存在不兼容问题，切换 context（`desktop-linux` / `default`）、重启 WSL2 均无效。

**解决方法：**
Docker Desktop → Settings → Software updates → 点击 "Update to latest" 升级到最新版，重启后恢复正常。
