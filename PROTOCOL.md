# Bambu Lab P2S — LAN Protocol Notes

Reverse-engineering notes for the **Bambu Lab P2S** in **LAN Mode + Developer Mode**,
verified against firmware `ota 01.00.05.00` (August 2026).

> **Why this document exists.** The P2S reports a **new-generation state schema** that
> differs substantially from the X1/P1 series. Existing libraries (`pybambu`,
> `ha-bambulab`) were written against the older schema and may not parse P2S state
> completely. Everything below was captured directly from a real machine with the
> stdlib-only probe scripts in [`probes/`](./probes).

Placeholders used throughout: `<PRINTER_IP>`, `<ACCESS_CODE>` (the 8-character LAN
Access Code from the printer's screen), `<SERIAL>`.

---

## Port summary

| Port | Protocol | Status | Notes |
|------|----------|--------|-------|
| 8883 | MQTT over TLS | ✅ Works | State + control |
| 322  | RTSPS | ✅ Works | **H.264 direct — no transcoding needed** |
| 990  | FTPS (implicit TLS) | ✅ Works | Requires TLS session reuse |
| 6000 | Legacy proprietary camera | ❌ Dead on P2S | See below |
| 2021/UDP | SSDP discovery | ✅ Works | Yields serial number |

---

## 1. Discovery (SSDP)

The printer multicasts SSDP announcements to `239.255.255.250:2021`. The `USN`
header carries the **serial number**, which you need for MQTT topics.

```
M-SEARCH * HTTP/1.1
HOST: 239.255.255.250:2021
MAN: "ssdp:discover"
MX: 1
ST: urn:bambulab-com:device:3dprinter:1
```

Bind UDP `2021`, join the multicast group, and read `NOTIFY` frames. Note some
routers isolate multicast between wireless clients — if you get nothing, read the
serial off the printer's screen instead.

See [`probes/probe.py`](./probes/probe.py).

---

## 2. MQTT — state and control

```
Broker    mqtts://<PRINTER_IP>:8883
Username  bblp
Password  <ACCESS_CODE>
TLS       1.3, self-signed → disable chain verification or pin the cert fingerprint
Subscribe device/<SERIAL>/report
Publish   device/<SERIAL>/request
```

### 2.1 Commands

| Purpose | Payload |
|---|---|
| Full state dump | `{"pushing":{"sequence_id":"1","command":"pushall"}}` |
| Module versions | `{"info":{"sequence_id":"1","command":"get_version"}}` |
| Pause / Resume / Stop | `{"print":{"sequence_id":"1","command":"pause"\|"resume"\|"stop"}}` |
| Chamber light | `{"system":{"sequence_id":"1","command":"ledctrl","led_node":"chamber_light","led_mode":"on"}}` |
| Speed profile | `{"print":{"sequence_id":"1","command":"print_speed","param":"2"}}` (1 silent, 2 standard, 3 sport, 4 ludicrous) |
| Raw G-code | `{"print":{"sequence_id":"1","command":"gcode_line","param":"M104 S0\n"}}` |

### 2.2 Three gotchas that will cost you a day

1. **Reports are deltas.** The printer only sends changed fields. You must keep a
   full state object and **deep-merge** each report into it. Merge objects
   recursively but **replace arrays wholesale** — AMS tray arrays are sent as
   complete blocks, and element-wise merging leaves stale data behind.

2. **`pushall` is rate-limited in firmware.** Don't poll it. Send it once on
   connect, and again only after a long silence (≥5 min is a safe interval).
   Add your own cooldown on top.

3. **Concurrent MQTT connections are limited.** A persistent bridge holds one
   connection; running Bambu Studio at the same time can knock either one off.

---

## 3. State schema (P2S / new generation)

`pushall` returns **95 top-level fields** under `print`.

### 3.1 Commonly used fields

| Field | Example | Meaning |
|---|---|---|
| `gcode_state` | `RUNNING` | `IDLE` / `RUNNING` / `PAUSE` / `FINISH` / `FAILED` |
| `mc_percent` | `75` | Progress % |
| `mc_remaining_time` | `28` | Minutes remaining |
| `layer_num` / `total_layer_num` | `107` / `175` | Layer counters |
| `nozzle_temper` / `nozzle_target_temper` | `220.0` / `220.0` | Nozzle temps |
| `bed_temper` / `bed_target_temper` | `55.0` / `55.0` | Bed temps |
| `subtask_name` | `"my_model"` | Job name |
| `gcode_file` | `/data/Metadata/plate_6.gcode` | Active file |
| `spd_lvl` / `spd_mag` | `2` / `100` | Speed level / percentage |
| `wifi_signal` | `"-25dBm"` | Signal strength |
| `hms` | `[]` | **Error array — empty means healthy** |
| `print_error` | `0` | Error code |
| `lights_report` | `[{"mode":"on","node":"chamber_light"}]` | Lighting |
| `nozzle_type` / `nozzle_diameter` | `HS01` / `0.4` | Hotend |
| `sdcard` | `true` | SD card present |

### 3.2 P2S-specific subtrees — **not present on X1/P1**

This is the part existing libraries do not handle.

```jsonc
"device": {
  "airduct":  { "modeCur": 0, "modeList": [...], "parts": [...] },  // air duct control
  "nozzle":   { "exist": 1, "info": [{ "diameter": 0.4, "type": "HS01", "wear": 0 }] },
  "extruder": { "info": [{ "id": 0, "temp": ..., "stat": ... }], "state": 1 },
  "laser":    { "power": 0 },        // schema-reserved on P2S
  "ext_tool": { "calib": 2, "mount": 0, "low_prec": true },
  "plate":    { "base": 4, "cur_id": "P0101", "mat": 1 },
  "bed":      { "info": { "temp": 3604535 }, "state": 2 },   // packed, not degrees
  "ctc":      { "info": { "temp": 27 }, "state": 0 }          // chamber temperature
}
```

> ⚠️ **Chamber temperature lives at `device.ctc.info.temp`.** The P2S does **not**
> emit the `chamber_temper` field that X1/P1 use.

> ⚠️ `device.bed.info.temp` and `device.extruder.info[].temp` are **packed integers**,
> not degrees. Use the top-level `bed_temper` / `nozzle_temper` floats instead.

AI-detection toggles:

```jsonc
"xcam": {
  "spaghetti_detector": true,
  "first_layer_inspector": true,
  "printing_monitor": true,
  "print_halt": true,
  "halt_print_sensitivity": "medium"
}
```

Camera configuration — **the printer tells you its own stream URL**:

```jsonc
"ipcam": {
  "resolution": "1080p",
  "rtsp_url": "rtsps://<PRINTER_IP>:322/streaming/live/1",
  "timelapse": "enable",
  "ipcam_record": "disable"
}
```

### 3.3 AMS trays — `ams.ams[n].tray[]`

```jsonc
{
  "id": "0",
  "tray_type": "PLA",
  "tray_sub_brands": "PLA Matte",
  "tray_info_idx": "GFA01",
  "tray_color": "000000FF",        // RRGGBBAA
  "remain": 21,                    // percent remaining, -1 if unknown
  "nozzle_temp_min": "190",
  "nozzle_temp_max": "230",
  "drying_temp": "55",
  "drying_time": "8",
  "tray_uuid": "...",
  "tag_uid": "..."
}
```

An empty slot reports an empty `tray_type`.

### 3.4 Module versions (`get_version`)

```
ota      sw=01.00.05.00
n3f/0    hw=N3F05      sw=03.00.21.29    <- AMS
ahb      hw=AHB-N703   sw=01.00.11.61
th       hw=TH03       sw=01.00.18.65    <- toolhead
smc      hw=SMC01      sw=01.00.12.63
mc       hw=MC06       sw=01.00.62.35    <- motion control
ap2      hw=AP02       sw=00.00.03.45
```

### 3.5 All 95 top-level fields

```
3D, ams, ams_rfid_status, ams_status, ap_err, aux, aux_part_fan, batch_id,
bed_target_temper, bed_temper, big_fan1_speed, big_fan2_speed, cali_version,
canvas_id, care, cfg, command, cooling_fan_speed, design_id, device, err,
fail_reason, fan_gear, file, force_upgrade, fun, gcode_file,
gcode_file_prepare_percent, gcode_state, heatbreak_fan_speed, hms, home_flag,
hw_switch_state, info, ipcam, job, job_attr, job_id, lan_task_id, layer_num,
lights_report, mapping, mc_action, mc_err, mc_percent, mc_print_error_code,
mc_print_stage, mc_print_sub_stage, mc_remaining_time, mc_stage, model_id, msg,
net, nozzle_diameter, nozzle_target_temper, nozzle_temper, nozzle_type, online,
percent, plate_cnt, plate_id, plate_idx, prepare_per, print_error,
print_gcode_action, print_real_action, print_type, profile_id, project_id,
queue, queue_est, queue_number, queue_sts, queue_total, remain_time, s_obj,
sdcard, sequence_id, spd_lvl, spd_mag, stat, state, stg, stg_cur, subtask_id,
subtask_name, task_id, total_layer_num, upgrade_state, upload, ver, vir_slot,
wifi_signal, xcam, xcam_status
```

---

## 4. Camera — RTSPS on port 322

**The P2S emits H.264 directly. No transcoding is required — just remux.**

```
URL       rtsps://<PRINTER_IP>:322/streaming/live/1
Auth      Digest (server identifies as LIVE555 Streaming Media v2023.03.30)
User      bblp
Password  <ACCESS_CODE>
TLS       1.2, self-signed
```

`DESCRIBE` returns:

```
m=video 0 RTP/AVP 96
a=rtpmap:96 H264/90000
a=fmtp:96 packetization-mode=1;profile-level-id=641029
b=AS:1000
```

- `profile-level-id=641029` → **H.264 High Profile, Level 4.1**
- `b=AS:1000` → **~1 Mbps**
- Resolution **1920×1080**

At 1 Mbps this is comfortably watchable over mobile data without re-encoding.
[go2rtc](https://github.com/AlexxIT/go2rtc) can ingest this URL directly and
republish as WebRTC/HLS with `-c:v copy` semantics.

### 4.1 Digest auth, not Basic

Send an unauthenticated `DESCRIBE` first, read `realm` and `nonce` from the
`WWW-Authenticate` header, then compute:

```
HA1      = MD5(username : realm : password)
HA2      = MD5(method : uri)
response = MD5(HA1 : nonce : HA2)
```

See [`probes/probe5.py`](./probes/probe5.py).

### 4.2 Port 6000 is dead on P2S

The legacy proprietary camera protocol (80-byte auth packet, then length-prefixed
JPEG frames) that works on P1/older X1 firmware **does not work here**. The port
accepts TLS and the auth packet, then returns 24 bytes:

```
08000000 3f010300 00000000 00000000
```

That is not a JPEG stream. **Use RTSPS instead** — it is what `ipcam.rtsp_url`
advertises anyway.

---

## 5. FTPS — file access on port 990

```
ftps://<PRINTER_IP>:990    (implicit TLS)
User      bblp
Password  <ACCESS_CODE>
Server    vsFTPd 3.0.5
```

### 5.1 The gotcha: `require_ssl_reuse`

Data connections **must reuse the control connection's TLS session**. Otherwise:

```
522 SSL connection failed: session reuse required
```

Node's [`basic-ftp`](https://github.com/patrickjuchli/basic-ftp) handles this
automatically (`secure: "implicit"`). Python's `ftplib` does **not** — you must
subclass:

```python
class BambuFTPS(ftplib.FTP_TLS):
    def __init__(self, *a, **k):
        self._sock = None
        super().__init__(*a, **k)

    @property
    def sock(self):
        return self._sock

    @sock.setter
    def sock(self, v):
        # implicit TLS: wrap the control socket immediately
        if v is not None and not isinstance(v, ssl.SSLSocket):
            v = self.context.wrap_socket(v, server_hostname=self.host)
        self._sock = v

    def ntransfercmd(self, cmd, rest=None):
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            conn = self.context.wrap_socket(
                conn, server_hostname=self.host,
                session=self.sock.session,      # <- the critical bit
            )
        return conn, size
```

Full working version: [`probes/probe7.py`](./probes/probe7.py).

### 5.2 Directory layout

| Path | Contents |
|---|---|
| `/` | Sliced `.gcode.3mf` models |
| `/timelapse` | Timelapse `.mp4` files plus a `thumbnail/` subdirectory |
| `/ipcam` | `ipcam-record.*.mp4` chunks (~268 MB each — these accumulate) |
| `/cache`, `/model`, `/image` | Usually empty |

---

## 6. Probe scripts

Pure-stdlib Python, no dependencies. Run them against your own printer:

```bash
python3 probes/probe.py  <printer-ip> <access-code>            # SSDP + MQTT + camera port fingerprint
python3 probes/probe2.py <printer-ip> <access-code> <serial>   # get_version + key state fields
python3 probes/probe3.py <printer-ip> <access-code> <serial>   # device / ipcam / xcam subtrees
python3 probes/probe5.py <printer-ip> <access-code>            # RTSP DESCRIBE (Digest) -> SDP
python3 probes/probe7.py <printer-ip> <access-code>            # FTPS directory listing
```

They also accept `BAMBU_HOST` / `BAMBU_ACCESS_CODE` / `BAMBU_SERIAL` environment
variables. `probe.py` includes a minimal MQTT 3.1.1 client (~80 lines) if you want
to see the wire format without pulling in a library.

---

## 7. Stability warning

Bambu Lab has repeatedly tightened LAN Mode and Developer Mode across firmware
releases. **Everything here is valid for `ota 01.00.05.00` and may break on
update.** Consider disabling automatic firmware updates if you depend on this,
and check community reports before upgrading.

---

## Credits

Prior art that made this faster: [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI)
by Doridian, and [ha-bambulab](https://github.com/greghesp/ha-bambulab) / `pybambu`.
Both target the X1/P1 schema; this document covers where the P2S diverges.
