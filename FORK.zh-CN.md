# 媒体选择分支

基于 Motrix v2.4.5（`6099f17c585e5accb45972283a638229f24ab64b`），为 Web/Server 和共用桌面界面的“新建任务”增加插件提供的媒体选择弹窗。这是独立维护的源码改动，不是上游官方发行版。

## 使用

在修改后的宿主中安装配套 Bilibili `.moext` 插件，授权清单中的权限，并在 Motrix 媒体工具中配置可用的 FFmpeg。粘贴一条 B 站视频页面链接，点击下载。单 P 视频会直接按插件返回的最高画质创建任务；多 P 视频才打开选择弹窗，选择分 P 和清晰度后确认。每个选中的 P 会成为独立媒体任务，并按视频及分 P 标题命名为 MP4。

没有合适解析插件的普通链接继续使用原有流程。取消弹窗不会创建下载任务。媒体地址在提交时解析；界面逐 P 请求，避免全部 P 塞进一个长请求导致代理超时。同一次选择的凭据会在当前服务端进程中去重重试，十分钟后过期；它不是跨重启的永久下载历史。

## 构建与运行

`vendor/sdk/` 包含私有 SDK 2.3.0-media.1 压缩包。开发和生产依赖层都读取这些固定文件，不依赖尚未发布的 npm 包，也不需要相邻 SDK 仓库。

有 Docker BuildKit 时：

```sh
docker build --build-arg TARGETARCH=amd64 -t motrix-server:media-selection .
MOTRIX_IMAGE=motrix-server:media-selection docker compose up -d
```

标准 Compose 保留上游的数据卷布局。替换现有实例前备份数据目录，不能让两个运行中的实例共用同一个数据目录。初次评估建议使用独立目录。

媒体选择分支通过 CI 将验证过的 linux/amd64 镜像发布到 GHCR：

```sh
docker pull ghcr.io/zyphoriate/motrix-server:media-selection
MOTRIX_IMAGE=ghcr.io/zyphoriate/motrix-server:media-selection docker compose up -d
```

工作流还发布 `media-selection-amd64` 和固定提交的 `sha-<完整提交号>` 标签，摘要会记录镜像 digest。GHCR 包若为私有，先使用具有 `read:packages` 权限的令牌执行 `docker login ghcr.io`；公开包支持匿名拉取。

使用导出的镜像文件：

```sh
docker load -i motrix-server-media-selection-linux-amd64.tar.gz
MOTRIX_IMAGE=motrix-server:media-selection-amd64 docker compose up -d
```

Bilibili 插件源码和 `.moext` 构建产物位于 [Zyphoriate/motrix-bilibili-resolver](https://github.com/Zyphoriate/motrix-bilibili-resolver)，安装该仓库 Build 工作流生成的插件包。

源码构建仍需要上游的原生文件发布辅助程序等环境，合并分轨需要 FFmpeg。若 Docker 仅有 legacy builder，可在本地 Dockerfile 副本中移除三处 `RUN --mount=type=cache` 的缓存挂载参数；它们只影响依赖缓存，不影响功能。显式指定 `TARGETARCH=amd64`，或构建环境支持的目标架构。本次验证和导出的镜像是 linux/amd64，不包含 ARM64 二进制镜像。

## SDK 协议

站点解析插件声明公开的 `<plugin-id>.inspectMedia` 和 `<plugin-id>.resolve` 命令。检查命令返回有大小限制的列表：协议版本、总标题、不重复的稳定条目 ID、规范页面链接、可选 P 编号/时长和清晰度。非视频页面可返回 null。宿主使用本地 SDK 的 `MediaCollectionSchema` 校验；用户确认后逐条调用 `.resolve`，由宿主任务服务下载直链或分轨并合并。

新增的是命令约定、类型和数据校验，不是让沙箱插件任意创建任务或运行程序。目录授权仍由宿主处理；视频和音频各自保留请求头。媒体运行时不再跟浏览器扩展连接一起销毁。用户主动重启服务端引擎前会取消并等待现有媒体工作结束；不承诺引擎意外崩溃后自动续传媒体分片。

## 验证与限制

已覆盖相关后端/界面测试、SDK 和协议测试、类型、lint、架构检查、服务端/Web 生产构建，以及真实 Chromium 下的选择/取消/切清晰度/提交和桌面/窄屏布局。浏览器验收使用真实生产组件及模拟通信，本身不能替代完整服务端验收；容器运行验证另有记录。

早期运行上游全量测试出现过失败，因此不宣称整个上游测试集全绿。后续验证限制为相关测试并使用单 worker，避免资源压力。

匿名 1080P 能否取得仍取决于 B 站实际接口；实现请求 DASH，再由 FFmpeg 合并。大会员/DRM 内容不在范围内。目前只对“新建任务”中的单条页面链接弹出选择，不自动展开批量粘贴的每一条链接。群晖原生套件的媒体文件所有权证明流程尚未为本功能扩展，本次使用 Docker Server 发行方式。

## 跟进上游

保留独立功能分支和指向 `https://github.com/agalwood/Motrix.git` 的上游 remote。合入新版本时重点审查新建任务、插件命令、媒体协调器和服务端打包。不要修改旧版 `master`。SDK 源码协议变化后重新打包 tarball、更新依赖锁文件并重跑相关检查。维护中的 fork 位于 [Zyphoriate/Motrix](https://github.com/Zyphoriate/Motrix)，改动保留在媒体选择功能分支中供审查。
