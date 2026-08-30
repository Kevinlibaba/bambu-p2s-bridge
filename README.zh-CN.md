# bambu-p2s-bridge

给锁在**局域网模式**下的 **Bambu Lab P2S** 做的远程监控与控制，全程走
[Tailscale](https://tailscale.com)，**零公网暴露**，链路上没有任何云服务。

[English](./README.md)

<img src="docs/screenshot-monitor.png" width="300" alt="监控页">

如果你的打印机因为锁区用不了 Bambu Handy，或者你单纯不想让打印机连云，
这个项目让你按自己的方式把手机端拿回来。

---

## 项目构成

| 目录 | 作用 |
|---|---|
| [`bridge/`](./bridge) | Node/TypeScript 桥接服务。对打印机说 MQTT/FTPS，对外暴露带鉴权的 REST + WebSocket API，并代理摄像头。 |
| [`app/`](./app) | uni-app（Vue 3 + TS）客户端。一份代码 → **H5/PWA、iOS、Android、微信小程序**。 |
| [`probes/`](./probes) | 零依赖的 Python 协议探针。**先跑这个**。 |
| [`PROTOCOL.md`](./PROTOCOL.md) | **P2S 局域网协议逆向笔记。** P2S 用的是新一代状态 schema，现有库解析不全。 |

---

## 为什么要做桥接，而不是让手机直连打印机

你确实可以用 Tailscale 子网路由把局域网整个打通，跳过这一切。但那样每个客户端都得
自己实现：自签证书的 MQTT over TLS、Digest 认证的 RTSPS、要求 TLS session 复用的
FTPS —— 还得在手机上、在后台、靠电池跑。而且推送通知没有地方发。

桥接服务把这些做一次，跑在一台常开的机器上，对外只给一个平平无奇的 HTTP API。

---

## 关键发现（详见 [PROTOCOL.md](./PROTOCOL.md)）

- **摄像头本来就输出 H.264。** `rtsps://<打印机>:322/streaming/live/1`，1080p 约 1 Mbps。
  不需要转码，remux 即可。P1/老 X1 固件用的 6000 端口私有 JPEG 协议在 **P2S 上已失效**。
- **P2S 的状态 schema 不是 X1/P1 那套。** 多了 `device.airduct`、`device.extruder[]`、
  `device.nozzle[]`、`device.ext_tool`，AMS 模块名 `n3f`。
  **腔温挪到了 `device.ctc.info.temp`，没有 `chamber_temper` 字段。**
- **MQTT 上报是增量的**，必须深合并，且数组要整体替换。
- **FTPS 要求 TLS session 复用**（否则报 `522 SSL connection failed`）。
  Node 的 `basic-ftp` 自动处理；Python 的 `ftplib` 需要自己继承改写。

---

## 快速开始

**前置**：P2S 开启局域网模式 + 开发者模式，记下 8 位访问码；一台与打印机同网段的
常开 Linux 主机；主机和手机都装 Tailscale。

```bash
# 1. 先验证协议（零依赖）
python3 probes/probe.py  <打印机IP> <访问码>
python3 probes/probe5.py <打印机IP> <访问码>   # 摄像头
python3 probes/probe7.py <打印机IP> <访问码>   # 文件

# 2. 配置
cp bridge/.env.example .env
# 填 BAMBU_HOST / BAMBU_SERIAL / BAMBU_ACCESS_CODE
# API_TOKEN 用 openssl rand -hex 24 生成
chmod 600 .env

# 3. 起服务
docker compose up -d --build

# 4. 构建前端并交给桥接服务托管
cd app && npm install && npm run build:h5
cp -R dist/build/h5/. ../bridge/public/
docker compose up -d --build bridge

# 5. 通过 Tailscale 暴露（拿到 Let's Encrypt 正式证书）
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

完整的 `docker-compose.yml` 与 `go2rtc.yaml` 见 [English README](./README.md#quick-start)。

> ⚠️ **不要开 Tailscale Funnel**，那会把服务发布到公网。

---

## 安全设计

- 打印机永远不出网，桥接服务不监听公网接口。
- 传输走 Tailscale（WireGuard）端到端，没有云中转看得到你的数据。
- 凭据只存桥接主机的 `.env`（600 权限），不进 App，不进本仓库。
- go2rtc 自身没有鉴权，因此只监听 `127.0.0.1`，只能经桥接服务的鉴权代理访问。
- `gcode_line` 能直接驱动加热和运动，**默认关闭**，由 `ALLOW_RAW_GCODE` 控制。

---

## 多端状态

| 目标 | 状态 |
|---|---|
| H5 / PWA | ✅ 可用，加到主屏幕即有原生观感 |
| iOS / Android | ✅ `npm run build:app`（需 HBuilderX 或 DCloud 云打包） |
| 微信小程序 | ⚠️ **只能跑开发版/体验版** |

小程序的限制是平台策略而非代码问题：正式版下 `wx.request` 与 WebSocket 都要求
**HTTPS/WSS + 已备案域名**，而 `*.ts.net` 无法完成域名归属校验；`live-player`
还需要类目资质。要真正发布就得把服务暴露到公网配备案域名 —— 这与
「只走 Tailscale」的设计初衷冲突。构建目标保留着，取舍留给使用者。

---

## 进度

已完成：实时状态、摄像头、暂停/继续/停止、灯光、温度、速度、文件浏览、深浅色主题。

待办：
- [ ] 推送通知（打印完成 / HMS 报错 / 离线）
- [ ] 文件上传 + 远程启动打印（`project_file` + AMS 映射）
- [ ] WebRTC 信令代理 —— 真正的零转码视频链路
- [ ] App 内下载延时摄影

---

## 兼容性

在 **P2S / 固件 `ota 01.00.05.00`** 上验证。其他新一代 Bambu 机型可能相近；
**X1/P1 系列 schema 不同，本项目的解析不适用**，那些机型请用
[ha-bambulab](https://github.com/greghesp/ha-bambulab)。

Bambu Lab 多次收紧过局域网/开发者模式，固件升级可能导致失效。

## 致谢

[OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) ·
[ha-bambulab](https://github.com/greghesp/ha-bambulab) ·
[go2rtc](https://github.com/AlexxIT/go2rtc)

## 许可

MIT
