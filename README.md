# bambu-p2s-bridge

[![CI](https://github.com/Kevinlibaba/bambu-p2s-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Kevinlibaba/bambu-p2s-bridge/actions/workflows/ci.yml)

Remote monitoring and control for a **Bambu Lab P2S** locked to **LAN Mode**, over
[Tailscale](https://tailscale.com) — with **zero public exposure** and no cloud service
in the path.

<p align="center">
  <img src="docs/carousel.gif" width="300" alt="Live monitor feed, then files, pre-flight checks, history, drying and notifications">
</p>

<details>
<summary>Individual screens</summary>

<table>
  <tr>
    <td width="33%"><img src="docs/screenshot-monitor.png" alt="Monitor"></td>
    <td width="33%"><img src="docs/screenshot-control.png" alt="Control"></td>
    <td width="33%"><img src="docs/screenshot-files.png" alt="Files"></td>
  </tr>
  <tr>
    <td align="center"><sub>Monitor</sub></td>
    <td align="center"><sub>Control</sub></td>
    <td align="center"><sub>Files</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshot-preflight.png" alt="Pre-flight checks and per-filament tray selection"></td>
    <td><img src="docs/screenshot-history.png" alt="Print history"></td>
    <td><img src="docs/screenshot-notify.png" alt="Push notifications"></td>
  </tr>
  <tr>
    <td align="center"><sub>Pre-flight checks and per-filament tray selection</sub></td>
    <td align="center"><sub>Print history</sub></td>
    <td align="center"><sub>Push notifications</sub></td>
  </tr>
</table>

</details>

If your printer is region-locked out of Bambu Handy, or you simply don't want your
printer talking to a cloud, this gives you the phone app back on your own terms.

---

## What's here

| Piece | What it does |
|---|---|
| [`bridge/`](./bridge) | Node/TypeScript service. Speaks MQTT/FTPS to the printer, exposes a clean REST + WebSocket API with bearer auth, and proxies the camera. |
| [`app/`](./app) | Web client (uni-app / Vue 3 + TS). Builds to **H5 / PWA** — installable to the home screen. |
| [`install.sh`](./install.sh) | One-command deploy: discovers the printer, generates keys, builds, starts, verifies. |
| [`probes/`](./probes) | Dependency-free Python scripts that verify each printer protocol. Run these first. |
| [`PROTOCOL.md`](./PROTOCOL.md) | **Reverse-engineering notes for the P2S LAN protocol.** The P2S uses a new-generation state schema that existing libraries don't fully parse. |

> ### ⚠︎ "Harvest" (part ejection) is experimental
>
> The app can push a finished part off the plate with the toolhead. It works — but it is
> the one feature here that moves the machine against a physical object, and getting it
> wrong costs hardware rather than a retry.
>
> What has actually happened during development, all documented in
> [PROTOCOL.md §5.4b](./PROTOCOL.md):
>
> - **It knocked the toolhead's front cover off.** The route dropped Z ten millimetres
>   behind the part — behind the *nozzle*, nowhere near behind the *head*, which has a
>   72 mm envelope.
> - A part with a **brim** does not come off; the brim tethers it and snaps it back.
> - A **long thin** part spins in place instead of sliding.
> - Z homing probes at the bed centre, so a centred part gets the nozzle driven into it
>   unless the probe point is moved.
>
> All four are guarded against now, and the sequence that works is written down. But the
> reduced-motor-current protection has never actually had to save anything, and the
> "harvest automatically when this print finishes" path has only ever run in unit tests.
> **Stand next to the machine the first few times.**

---

## Why a bridge instead of talking to the printer directly

You *can* expose the printer's LAN with a Tailscale subnet router and skip all of this.
But then every client has to implement MQTT-over-TLS with a self-signed cert, RTSPS with
digest auth, and FTPS with TLS session reuse — on mobile, in the background, on battery.
And you still have nowhere to run push notifications from.

The bridge does that once, on a machine that's always on, and hands out a boring HTTP API.

```
Printer (LAN only)                Bridge host                    Phone
├── MQTT/TLS  :8883  ──┐          ┌──────────────────┐          ┌──────────┐
├── RTSPS     :322   ──┼─────────▶│ go2rtc (remux)   │          │          │
└── FTPS      :990   ──┘          │ bridge (API+auth)│◀────────▶│ uni-app  │
                                  │ tailscale        │ Tailscale│          │
                                  └──────────────────┘  (WG)    └──────────┘
```

---

## Key findings (details in [PROTOCOL.md](./PROTOCOL.md))

- **The camera already outputs H.264.** `rtsps://<printer>:322/streaming/live/1`,
  1080p at ~1 Mbps. No transcoding — just remux. The legacy port-6000 JPEG protocol
  used by P1/older X1 firmware is **dead on the P2S**.
- **The P2S state schema is not the X1/P1 schema.** `device.airduct`,
  `device.extruder[]`, `device.nozzle[]`, `device.ext_tool`, AMS module `n3f`.
  Chamber temperature moved to `device.ctc.info.temp` — there is no `chamber_temper`.
- **MQTT reports are deltas** and must be deep-merged, with arrays replaced wholesale.
- **FTPS requires TLS session reuse** (`522 SSL connection failed` otherwise).
  Node's `basic-ftp` handles it; Python's `ftplib` needs a subclass.
- **`ams_mapping` is indexed by the slicing project's filament number**, and its length
  must equal the project's filament count — not the number of filaments the plate uses.
  Get it wrong and the printer pauses at 0 % with `0x07008012`.
- **`close_power_conflict` must be `true`** to start AMS drying. With `false` the
  printer silently ignores the whole command: no error, no state change.

---

## Quick start

### Prerequisites

- P2S in **LAN Mode** with **Developer Mode** enabled — note the 8-character Access Code
- An always-on Linux host on the same LAN (LXC container, Raspberry Pi, NAS, …) with
  **Docker** and the Compose plugin
- Optional: Tailscale on that host and on your phone, to reach it from outside

### One command

```bash
git clone https://github.com/Kevinlibaba/bambu-p2s-bridge.git
cd bambu-p2s-bridge
./install.sh
```

It finds the printer over SSDP, asks for the Access Code, generates the API token and
the Web Push keys, builds both images, starts everything, and verifies it can actually
talk to the printer before telling you it worked. Then it prints the URL and token to
enter on your phone.

Node is **not** a prerequisite — the web app is built inside the image.

```
==> 查找打印机
  监听 SSDP 广播，约 8 秒…
  选中 192.168.1.42（00M00A000000000）
...
==> 自检
  接口已就绪：{"ok":true,"printerConnected":true,...}
  打印机：在线，状态 RUNNING

部署完成
  地址   http://192.168.1.10:8080/app/
  Token  8f3a…（48 位十六进制）
```

Re-running it is safe: it offers to keep the existing `.env` and just rebuild.

Non-interactive:

```bash
BAMBU_ACCESS_CODE=xxxxxxxx ./install.sh --yes --no-tailscale
```

### Check your printer first (optional)

If something doesn't work, these tell you which protocol is at fault. Stdlib only.

```bash
python3 scripts/discover.py                           # find printers on the LAN
python3 probes/probe.py  <printer-ip> <access-code>   # MQTT
python3 probes/probe5.py <printer-ip> <access-code>   # camera
python3 probes/probe7.py <printer-ip> <access-code>   # files
```

### Expose over Tailscale

`install.sh` offers to do this if `tailscale` is on the host. By hand:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

You get `https://<node>.<tailnet>.ts.net` with a real Let's Encrypt certificate,
reachable only from your tailnet. **Do not enable Funnel** unless you add another
layer of auth — that publishes to the internet.

<details>
<summary>Doing it by hand instead</summary>

```bash
cp bridge/.env.example .env
# BAMBU_HOST / BAMBU_SERIAL / BAMBU_ACCESS_CODE
# API_TOKEN: openssl rand -hex 24
# VAPID keys (optional, for Web Push): npx web-push generate-vapid-keys
chmod 600 .env
mkdir -p data

docker compose up -d --build
```

`docker-compose.yml` and `go2rtc.yaml` are in the repo. go2rtc binds its API to
localhost only — it has **no authentication of its own**, so the bridge is the only
way in. Don't change that to `0.0.0.0`.

The bridge serves the web app at `/app/` (auth-exempt so the shell can load before you
enter a token) and redirects `/` there. `./data` holds push subscriptions and print
history and must survive container rebuilds.

</details>

## API

Bearer token on everything except `/api/health` and `/app/**`.
`<img>`/WebSocket contexts can pass `?token=`.

| Method | Path | |
|---|---|---|
| `GET` | `/api/health` | Liveness (no auth) |
| `GET` | `/api/state` | Derived summary: progress, temps, AMS, lights, errors |
| `GET` | `/api/state/raw` | All 95 raw fields |
| `POST` | `/api/command` | Whitelisted commands |
| `GET` | `/api/files?path=/` | FTPS listing |
| `GET` | `/api/files/stream?path=…` | Stream a file inline — **HTTP Range / `206`**, for `<video>` |
| `GET` | `/api/files/download?path=…` | Same bytes, `Content-Disposition: attachment` |
| `GET` | `/api/files/3mf?path=…` | `.gcode.3mf` metadata — per-plate time, filament, objects |
| `GET` | `/api/files/3mf/plate.png?path=…&plate=1` | Plate preview extracted from inside the 3MF |
| `GET` | `/api/camera/snapshot.jpg` | Single frame (authenticated proxy) |
| `WS` | `/api/camera/ws` | WebRTC signalling, proxied to go2rtc with auth |
| `POST` | `/api/files/upload` | Import a sliced 3MF (streamed multipart) |
| `POST` | `/api/files/import` | Import from a URL — the bridge fetches it |
| `DELETE` | `/api/files?path=…` | Delete a file |
| `GET` | `/api/print/plan?path=…&plate=1` | Dry run: which tray each filament resolves to, plus pre-flight checks |
| `POST` | `/api/print/start` | Start a print from a file already on the card |
| `GET` | `/api/errors?lang=zh-Hans` | Active errors with the official description resolved |
| `POST` | `/api/errors/clear` | Dismiss the current `print_error` |
| `POST` | `/api/ams/dry/start` \| `/stop` | AMS filament drying |
| `POST` | `/api/ams/unload` | Unload filament back into the AMS |
| `GET` | `/api/history?limit=50` | Job log and monthly stats |
| `GET` | `/api/history/temps?minutes=60` | Temperature samples for the chart |
| `GET` | `/api/notify` | Push status, configured sinks, recent notifications |
| `POST` | `/api/notify/subscribe` \| `/unsubscribe` | Web Push subscription |
| `POST` | `/api/notify/test` | Fire a test notification through every sink |
| `WS` | `/api/events` | Live state push |

`/api/files/stream` and `/api/files/download` both honour `Range` and answer `206
Partial Content` with `Content-Range` / `Accept-Ranges` / an exact `Content-Length`,
so a `<video>` element can seek. FTP has no way to stop a transfer mid-flight, so the
bridge counts bytes on the way out and destroys the FTP connection once the requested
range is satisfied — including when the phone walks away. Concurrent reads are capped
(one FTP connection per range request; the printer does not have many to give).

`/api/files/3mf*` reads the ZIP central directory over `REST` and pulls out only the
entries it needs. A whole 3MF is never shipped to the phone, and never fully buffered
on the bridge.

Commands are a closed whitelist with range validation:

```jsonc
{"type":"pause"} {"type":"resume"} {"type":"stop"}
{"type":"light","on":true}
{"type":"speed","level":2}              // 1 silent … 4 ludicrous
{"type":"nozzleTemp","celsius":220}     // capped at 300
{"type":"bedTemp","celsius":55}         // capped at 110
{"type":"home"}
{"type":"pushall"}                      // 30s cooldown
{"type":"gcode","lines":"..."}          // 403 unless ALLOW_RAW_GCODE=true
```

---

### Notifications

Remote access is only half useful if you have to keep the app open to learn anything.
The bridge watches state transitions and pushes: print started / finished / paused /
failed, a new printer error, drying finished, printer offline / back.

Sinks are pluggable and fire in parallel — **Web Push** (no third party involved; the
PWA receives it even when closed), **Bark**, **ntfy**, **Telegram**, and a generic
webhook. Configure whichever you want in `.env`; everything left blank is skipped.
Error notifications resolve the code against Bambu's error database first, so the
message is a sentence rather than a hex string.

Noise control matters more than delivery here: events fire only on transitions, the
same event key is suppressed for 10 minutes (the printer re-reports an active error
every second), and a pause/failure that already carries an error code doesn't also
fire a separate error notification.

```bash
# Web Push — no third-party service, works on iOS once installed to the home screen
npx web-push generate-vapid-keys     # → VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

> **iOS:** Safari only grants notification permission to a PWA that has been added to
> the Home Screen. Open the app, Share → Add to Home Screen, then launch it from the
> icon — the settings page shows this hint automatically when it detects otherwise.

### Pre-flight checks

Starting a print remotely means nobody is standing next to the machine. Before the
command goes out, `/api/print/plan` reports — and `/api/print/start` refuses on —
whatever it can determine from the sliced file plus printer state:

| Check | Source |
|---|---|
| Enough filament | `remain %` × `tray_weight` from the RFID tag, against the plate's `used_g` |
| Filament type matches | tray `tray_type` vs the slice, compared by family (PLA Matte counts as PLA) |
| Nozzle diameter matches | `nozzle_diameters` in the 3MF vs `nozzle.diameter` |
| Printer idle, SD card present | state |
| Slicer warnings | the `<warning>` elements already sitting inside `slice_info.config` |

Blocking findings return `409` with the list; the client can retry with
`{"force": true}` after showing them to a human. The busy-state guard sits in front of
that and cannot be forced.

### Print history

LAN mode gives you no job history at all — close the app and the run is gone. The
bridge keeps its own log (JSONL, appended, one line per job) with name, plate, start
and end, duration, result, layers, and the estimated filament weight looked up from the
sliced file. From that it derives monthly totals and a success rate.

Jobs the bridge did not observe the start of (it was restarted mid-print) are recorded
with `partial: true` and no duration, rather than a fabricated one.

### Camera

The printer emits H.264 already, so go2rtc republishes it over WebRTC without
re-encoding: full frame rate at the same ~1 Mbps the source uses. Measured on a
phone-sized viewport: **1920×1080 at 30 fps, no dropped frames**.

Only signalling passes through the bridge — `/api/camera/ws` relays to go2rtc's
WebSocket behind the same bearer token. Media goes straight from go2rtc to the
client over the tailnet, so video never touches Node's event loop.

If WebRTC cannot establish within 8 seconds the app falls back to polling single
frames, which is also the explicit "data saver" mode.

> An MJPEG endpoint used to be listed here. It never worked: go2rtc has no
> transcoder in this image, so `H264 => JPEG` fails outright. Removed rather
> than fixed — transcoding to MJPEG would cost 5–10× the bandwidth of the
> WebRTC path for worse quality.

### Importing and printing

`POST /api/files/upload` streams multipart straight through to the printer's FTPS —
a 35 MB slice is never held in memory. After the write the file is re-opened over
ranged reads and validated as a real 3MF; anything that fails is deleted again, so a
renamed `.txt` cannot sit on the card pretending to be a model. `/api/files/import`
takes a URL and does the same, with the bridge doing the fetching — on a wired link
that is a lot faster than pushing 35 MB up from a phone.

`POST /api/print/start` is the only endpoint that makes the machine heat and move,
so the checks are server-side rather than trusted from the client: the file must
already be on the card, it must parse as a 3MF, the requested plate must exist, the
AMS mapping must be integers, and the printer must not already be printing. The app
adds a confirmation that spells out what is about to happen.

> ⚠️ The `project_file` payload follows the documented X1/P1 shape. It has **not been
> verified end to end on a P2S** — doing so means starting a real print. Supervise the
> first one.

## Security model

- The printer never reaches the internet. The bridge never listens on a public interface.
- Transport is Tailscale (WireGuard) end to end. No cloud relay sees your data.
- Credentials live only in `.env` (mode 600) on the bridge host — never in the app,
  never in this repo.
- go2rtc has no auth of its own, so it is bound to `127.0.0.1` and reachable only
  through the bridge's authenticated proxy.
- `gcode_line` can drive heaters and motion. It is **off by default** and gated behind
  `ALLOW_RAW_GCODE`.

---

## About the app

The client is a **web app (H5 / PWA)**. Open it in a browser on your phone and use
*Add to Home Screen* — it runs full-screen with no browser chrome, which is close
enough to native for a monitoring tool.

It is built with [uni-app](https://uniapp.dcloud.io) rather than plain Vue because
native iOS/Android and Mini Program targets are on the roadmap and uni-app compiles
the same source to all of them. Only the H5 target is published today; the others
are not shipped until they have been validated on real devices.

## Status and roadmap

Working: live state, WebRTC camera, pause/resume/stop, lights, temperature, speed,
file browsing, in-app timelapse/recording playback, 3MF plate preview, dark/light
themes, importing sliced `.gcode.3mf` from the phone or from a URL, deleting files.

Also working: remote print start with per-filament tray selection and pre-flight
checks, AMS filament drying, reading and dismissing printer errors with the official
description resolved, push notifications, installable PWA, print history and monthly
stats, temperature chart.

Not done yet:
- [ ] Skip an object mid-print — protocol is mapped ([§2.6](./PROTOCOL.md#26-skipping-an-object-mid-print)); needs a real part sacrificed to verify
- [ ] Native iOS / Android builds
- [ ] Drying while printing — needs the separate AMS power adapter, which I don't have,
      so that path is unimplemented rather than untested
- [ ] 3D mesh viewer for `3D/3dmodel.model` — deliberately skipped, see below

Verified on hardware except: Web Push delivery to a real device (the bridge-side
pipeline is verified end to end; only the browser → push-service leg is untested).

### Why there is no mesh viewer

The 3MF preview shows the plate render that Bambu Studio already baked into the file,
plus the figures parsed from `Metadata/slice_info.config`. That is a few hundred KB and
works on every uni-app target.

An actual mesh viewer would mean three.js plus an XML mesh parser, a WebGL canvas that
only exists on the H5 target, and shipping megabytes of triangles to a phone — to show
the same object the baked render already shows, minus the toolpath. It was not worth the
weight. If it ever lands it should be lazy-loaded so it costs nothing when unused.

---

## Compatibility

Verified on a **P2S** running `ota 01.00.05.00`. The AMS/camera/FTPS parts are likely
similar on other new-generation Bambu machines; the X1/P1 series use a different state
schema and are **not** supported by the parsing here — for those, use
[ha-bambulab](https://github.com/greghesp/ha-bambulab).

Bambu Lab has tightened LAN/Developer Mode before. This may break on firmware update.

## Credits

[OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) ·
[Bootstrap Icons](https://github.com/twbs/icons) (MIT) ·
[ha-bambulab](https://github.com/greghesp/ha-bambulab) ·
[go2rtc](https://github.com/AlexxIT/go2rtc)

## License

MIT
