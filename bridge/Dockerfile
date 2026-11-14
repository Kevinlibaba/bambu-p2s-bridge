# syntax=docker/dockerfile:1.7
# 多段构建。app 与 bridge 各自编译，最终镜像只留运行期需要的东西。
# 构建上下文是仓库根目录（见 docker-compose.yml），这样一条
# `docker compose up -d --build` 就能出成品 —— 宿主机不需要装 Node。

# ---- 1. 前端（uni-app H5）----
# 三个阶段统一 node:22-slim（LTS）。以前钉在 Node 20（已 EOL），因为 22/24 上
# FTPS 数据连接的 TLS 会话复用失效，打印机的 vsftpd 回「522 session reuse required」。
# 根因已查清：Node 22.23 / 24.17 起（CVE-2026-48934 修补）会把 TLS session 绑定到
# 它认证过的主机身份，basic-ftp 开数据连接时没带 host，session 被静默丢弃。
# 修法在 src/printer/ftp.ts 的 secureOptions.host，22 和 24 都实测通过，
# 详见 PROTOCOL.md 5.1。再动 Node 版本时务必看 /api/files 而不是 /api/health ——
# MQTT、摄像头、界面全都正常，只有文件相关接口 502，冒烟测试很容易漏掉。
#
# 多架构（amd64 / arm64）：前三个阶段的产物都是纯 JS，与目标架构无关，所以钉在
# $BUILDPLATFORM 上原生跑 —— 否则 arm64 镜像的 npm install 和 uni-app 构建要在
# QEMU 里模拟执行，慢十几倍。只有最后的运行期阶段按目标架构出。
# 运行期依赖里没有原生模块（有安装脚本的 esbuild / fsevents 只在开发依赖里），
# 新增依赖时要再确认一遍。
FROM --platform=$BUILDPLATFORM node:22-slim AS app
WORKDIR /src
COPY app/package*.json ./
RUN npm install --no-audit --no-fund
COPY app/ ./
RUN npm run build:h5

# ---- 2. 桥接服务 ----
FROM --platform=$BUILDPLATFORM node:22-slim AS build
WORKDIR /app
COPY bridge/package*.json bridge/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY bridge/src ./src
RUN npm run build

# ---- 3. 运行期依赖（纯 JS，同样在构建机上装好再拷过去）----
FROM --platform=$BUILDPLATFORM node:22-slim AS deps
WORKDIR /app
COPY bridge/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- 4. go2rtc（单容器模式内置，见 GO2RTC_EMBED）----
# 钉在实测可用的 v1.9.14（CT102 上跑的就是它），用官方发布页的 sha256 校验。
# 按目标架构各取各的静态二进制；FROM go2rtc-${TARGETARCH} 选中其中一个。
FROM scratch AS go2rtc-amd64
ADD --checksum=sha256:32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6 \
    https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_linux_amd64 /go2rtc
FROM scratch AS go2rtc-arm64
ADD --checksum=sha256:359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50 \
    https://github.com/AlexxIT/go2rtc/releases/download/v1.9.14/go2rtc_linux_arm64 /go2rtc
FROM go2rtc-${TARGETARCH} AS go2rtc

# ---- 5. 运行期 ----
FROM node:22-slim
ARG TARGETARCH
WORKDIR /app
ENV NODE_ENV=production

# BambuStudio 的 AppImage 自带 FFmpeg，但不带 GTK/WebKit 那一串系统库。
# 少了它们 bin/bambu-studio 连动态链接都过不去（libfontconfig.so.1 找不到），
# 跟有没有图形界面无关 —— CLI 切片同样要链接。
#
# 这一层放在 COPY 之前：代码改动不会让它失效，重建时走缓存。
# 切片器本体（540MB）不进镜像，由 compose 从宿主机挂载，见 SLICER_ROOT。
#
# BambuStudio 只发 x86_64 的 Linux 版，arm64（树莓派等）上切片本来就用不了，
# 这几百 MB 的库只装在 amd64 镜像里。arm64 上切片会因为找不到切片器自动关闭。
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends \
           libwebkit2gtk-4.1-0 libgtk-3-0 libglu1-mesa \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# go2rtc 截图（/api/frame.jpeg）要调 ffmpeg 把 H.264 帧转成 JPEG。官方 go2rtc 镜像里自带，
# 我们内置的只是个二进制，所以要自己装 —— 少了它推送快照、收菜后的照片、队列的安全确认都拿不到图。
# 两容器部署时截图走的是 go2rtc 容器自己的 ffmpeg，这里装上也不碍事。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY bridge/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=app /src/dist/build/h5 ./public
# 单容器模式用：GO2RTC_EMBED=1 时桥接自己把 go2rtc 拉起来。两容器的 compose 部署用不到它
COPY --from=go2rtc --chmod=755 /go2rtc /usr/local/bin/go2rtc
COPY bridge/go2rtc.embedded.yaml /app/go2rtc.yaml
EXPOSE 8080
CMD ["node", "dist/index.js"]

LABEL org.opencontainers.image.source="https://github.com/Kevinlibaba/bambu-p2s-bridge" \
      org.opencontainers.image.description="Bambu Lab P2S LAN-mode bridge + web app" \
      org.opencontainers.image.licenses="MIT"
