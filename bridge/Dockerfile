# 三段构建。app 与 bridge 各自编译，最终镜像只留运行期需要的东西。
# 构建上下文是仓库根目录（见 docker-compose.yml），这样一条
# `docker compose up -d --build` 就能出成品 —— 宿主机不需要装 Node。

# ---- 1. 前端（uni-app H5）----
# Node 20 是刻意钉死的，不要顺手升级。
# 22 和 24 上 basic-ftp 的 TLS 会话复用失效，打印机的 vsftpd 会回
# 「522 session reuse required」—— MQTT、摄像头、界面全都正常，只有
# 文件相关的接口 502，冒烟测试很容易漏掉。详见 PROTOCOL.md 5.1。
FROM node:20-slim AS app
WORKDIR /src
COPY app/package*.json ./
RUN npm install --no-audit --no-fund
COPY app/ ./
RUN npm run build:h5

# ---- 2. 桥接服务 ----
FROM node:20-slim AS build
WORKDIR /app
COPY bridge/package*.json bridge/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY bridge/src ./src
RUN npm run build

# ---- 3. 运行期 ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# BambuStudio 的 AppImage 自带 FFmpeg，但不带 GTK/WebKit 那一串系统库。
# 少了它们 bin/bambu-studio 连动态链接都过不去（libfontconfig.so.1 找不到），
# 跟有没有图形界面无关 —— CLI 切片同样要链接。
#
# 这一层放在 COPY 之前：代码改动不会让它失效，重建时走缓存。
# 切片器本体（540MB）不进镜像，由 compose 从宿主机挂载，见 SLICER_ROOT。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-0 libgtk-3-0 libglu1-mesa \
 && rm -rf /var/lib/apt/lists/*

COPY bridge/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=app /src/dist/build/h5 ./public
EXPOSE 8080
CMD ["node", "dist/index.js"]
