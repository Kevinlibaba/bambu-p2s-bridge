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
| Start a print | `{"print":{"command":"project_file",...}}` — see [§2.3](#23-starting-a-print-the-ams_mapping-trap) |
| AMS drying | `{"print":{"command":"ams_filament_drying",...}}` — see [§2.4](#24-ams-drying) |
| Skip objects | `{"print":{"command":"skip_objects","obj_list":[504]}}` — see [§2.6](#26-skipping-an-object-mid-print) |
| Unload filament | `{"print":{"command":"ams_change_filament","ams_id":0,"curr_temp":210,"tar_temp":210,"target":255,"slot_id":255}}` |
| Clear an error | `{"system":{"command":"uiop","name":"print_error","action":"close","source":1,"type":"dialog","err":"07004025"}}` — see [§2.5](#25-errors) |
| AMS resume/reset | `{"print":{"command":"ams_control","param":"resume"}}` (also `reset`, `pause`, `done`, `abort`) |

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

### 2.3 Starting a print: the `ams_mapping` trap

```json
{"print":{
  "command":"project_file",
  "param":"Metadata/plate_8.gcode",
  "url":"ftp:///M82.gcode.3mf",        // three slashes = SD card root, LAN mode
  "subtask_name":"M82",
  "use_ams":true,
  "ams_mapping":[-1,-1,-1,0],
  "bed_type":"auto","bed_leveling":true,"flow_cali":true,
  "vibration_cali":true,"layer_inspect":false,"timelapse":false,
  "profile_id":"0","project_id":"0","subtask_id":"0","task_id":"0"
}}
```

**`ams_mapping` is indexed by the slicing project's filament number, not by the
filaments this plate happens to use, and its length must equal the number of
filaments defined in the project.** Get this wrong and the printer retries the
mapping lookup a few times, then pauses at 0 % with
`print_error 0x07008012` — *"Failed to obtain the AMS mapping table"*.

Worked example. A project defines 4 filaments; plate 8 uses only filament #4:

```xml
<!-- Metadata/slice_info.config, plate 8 -->
<metadata key="filament_maps" value="1 1 1 1"/>     <!-- 4 entries = 4 project filaments -->
<filament id="4" tray_info_idx="GFA01" type="PLA" used_g="59.13"/>
```

The correct mapping is `[-1,-1,-1,0]` — length 4, only index 3 set. Sending `[0]`
(length 1) is what triggers 0x07008012.

- **Length** — take it from `filament_maps` in `slice_info.config`; the number of
  space-separated entries *is* the project filament count. Older files without that
  key: fall back to the highest `<filament id>` on the plate.
- **Value** — the global tray index, `ams_id * 4 + slot`. `-1` means "this filament
  number is unused on this plate". The external spool (`vir_slot`) is **254**, and it
  does *not* follow the `*4 +` formula.
- **Matching** — `tray_info_idx` in `slice_info.config` and in `ams.ams[n].tray[]` are
  the same namespace (`GFA01` etc.), so an exact match on that field is the most
  reliable way to pick a tray automatically.

### 2.4 AMS drying

```json
{"print":{
  "command":"ams_filament_drying",
  "ams_id":0,
  "mode":1,                    // DryCtrlMode: 0 = off, 1 = on-time
  "filament":"GFA01",
  "temp":55,
  "duration":8,                // HOURS — the firmware reports dry_time in minutes
  "humidity":0,
  "rotate_tray":false,
  "cooling_temp":40,
  "close_power_conflict":true
}}
```

- **`close_power_conflict` must be `true`.** With `false` the printer **silently
  ignores the entire command** — no error, no state change, `info` and `dry_time`
  untouched. It is the acknowledgement of the power-conflict dialog Bambu Studio
  shows when the AMS has no separate power supply.
- **`duration` is in hours.** `8` comes back as `dry_time: 480`.
- Stopping: this project sends the same command with `mode: 0`. BambuStudio instead
  has a dedicated `{"print":{"command":"auto_stop_ams_dry"}}` — both appear to work.
- Progress lives in the **`info` bitfield** of `ams.ams[n]` (hex string):
  `dryStatus = (parseInt(info,16) >> 4) & 0xF` → `0` off, `1` checking, `2` drying,
  `3` cooling. Observed: `1003` idle → `1013` checking → `1023` drying.
- Starting runs a filament-identification pass first (`checking`). If any tray's RFID
  cannot be read the pass fails and drying aborts after ~5 s — see §2.5 for how that
  surfaces.
- Per-spool recommended parameters ship in the RFID tag as
  `tray[].drying_temp` / `drying_time`. For spools without RFID, the authoritative
  defaults are in BambuStudio's filament profiles
  (`resources/profiles/BBL/filament/fdm_filament_*.json`), keys
  `filament_dev_ams_drying_temperature` / `_time`. **The first element of those
  arrays is the built-in AMS / AMS 2 Pro tier** and matches what the printer's own
  screen offers: PLA 45 °C/12 h, PETG 65 °C/12 h, PP 60 °C/12 h, PE 45 °C/12 h,
  everything else 65 °C/12 h.

### 2.5 Errors

Two separate channels, cleared in different ways:

| | Field | Meaning | Clearable over MQTT |
|---|---|---|---|
| Print error | `print_error` (int) | The single current dialog-style error | **Yes** |
| HMS | `hms[]` (`{attr, code}`) | Health entries — a condition that is *still true* | **No** |

**Hex codes.** `print_error` is 8 hex digits: `117456933` → `07004025`. An HMS entry is
16: the two halves of `attr` followed by the two halves of `code`, so
`{attr: 0x07002100, code: 0x00010086}` → `0700210000010086`.

**Human-readable text** comes from Bambu's own error database — the same endpoint
BambuStudio uses:

```
https://e.bambulab.com/query.php?lang=zh-cn&e=07004025
→ {"result":0,"data":{"device_error":{"zh-cn":[{"ecode":"07004025",
   "intro":"读取耗材信息失败"}]}}}
```

8-digit codes come back under `device_error`, 16-digit ones under `device_hms`.

**`lang` takes Bambu's own codes, not BCP-47.** Use the hyphenated form — `zh-cn`,
`zh-tw`, `en`, `ja`, `de`, `fr`. Anything else comes back `{"result":201,"data":""}`:
`zh`, `zh_cn` and `zh_CN` all fail, and so does **`zh-hant`** — traditional Chinese is
only reachable as `zh-tw` (`zh-hk` and `zh-mo` return nothing either). Keep your own
locale identifiers in BCP-47 (`zh-Hant`) and translate to Bambu's spelling at the
request boundary.

**Clearing.** `clean_print_error` did **not** work here. What does is the `system.uiop`
channel — BambuStudio's `command_clean_print_error_uiop`:

```json
{"system":{"command":"uiop","name":"print_error","action":"close",
           "source":1,"type":"dialog","err":"07004025"}}
```

Verified on hardware: `print_error` goes to `0` immediately. HMS entries stay —
BambuStudio has no MQTT command for those either; the printer withdraws them when the
underlying condition clears.

### 2.6 Skipping an object mid-print

```json
{"print":{"command":"skip_objects","obj_list":[504, 592]}}
```

Taken from BambuStudio's `MachineObject::command_task_partskip`. **Not implemented in
this project yet** — everything below is verified from the printer's own state and from
BambuStudio's source, except the last line of §2.6.4.

#### 2.6.1 Where the object IDs come from

`Metadata/slice_info.config`, per plate:

```xml
<object identify_id="504" name="Mündungsbremse R.stp" skipped="false" />
```

`obj_list` takes those `identify_id` values.

**There is a second, different ID for the same object and it is the wrong one.**
`Metadata/plate_N.json` carries `bbox_objects[].id` — for one object here that was
`899` while `slice_info.config` said `identify_id="757"`. The `plate_N.json` id feeds
BambuStudio's pick-image canvas (the clickable plate map), not the command.
`PartSkipDialog` builds its list through `ModelSettingHelper`, which parses
`slice_info.config`, and matches the printer's replies against those same
`identify_id`s.

#### 2.6.2 What the printer reports back

`print.s_obj` — an array of the object IDs already skipped on the current job.
Empty when nothing has been skipped. BambuStudio reads it into `m_partskip_ids` and
paints those entries as already-skipped.

#### 2.6.3 Two gates, both checkable before you offer the feature

**Does the printer support it** — bit 49 of `print.fun`, a hex-string bitfield:

```
fun = "29FD183FF9CB7"  →  (0x29FD183FF9CB7 >> 49) & 1 = 1     # P2S: supported
```

Same field carries other capabilities BambuStudio reads: bit 28 internal timelapse,
bit 39 MQTT bed control, bit 46 cooling filter, bit 48 external change assist,
bit 60 nozzle rack.

**Was the plate sliced with object labels** — `label_object_enabled` in that plate's
metadata:

```xml
<metadata key="label_object_enabled" value="true"/>
```

Without labels the G-code has no per-object markers and there is nothing to exclude.
Observed on a 13-plate project: `true` on exactly the plates holding more than one
object, `false` on every single-object plate. Bambu Studio only emits the labels when
a plate actually has something to exclude, so this is not a user setting you need to
chase — a single-object plate simply cannot be part-skipped, and skipping its only
object is the same thing as stopping the job.

#### 2.6.4 Behaviour to mirror

- **Skipping every object is not a skip.** BambuStudio checks for that case and calls
  `command_task_abort()` (`print.stop`) instead of `skip_objects`. Sending a full list
  would leave the machine running a job that prints nothing.
- **It cannot be undone.** The material is simply never laid down. Studio's own
  confirmation says so; any client should too.
- *Unverified:* whether the printer accepts IDs for an object it is currently laying
  down, and whether it rejects the command outside `RUNNING`. Confirming either costs
  a real part on a real print.

#### 2.6.5 Sketch of a client implementation

1. Offer the action only when `(fun >> 49) & 1` and the running plate's
   `label_object_enabled` is `true`.
2. Resolve the running job to a file and plate: `taskName` is the file name without
   its extension, and `print.gcode_file` / the state's `file` ends in
   `Metadata/plate_N.gcode` — the same lookup as §5.4.
3. List that plate's `<object>` entries, marking the ones already in `s_obj`.
4. Refuse a selection covering every remaining object; point the user at stop instead.
5. Publish `skip_objects` with the chosen `identify_id`s, then watch `s_obj` to confirm.

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
  "tray_weight": "1000",           // grams when full — remain% * this = grams left
  "nozzle_temp_min": "190",
  "nozzle_temp_max": "230",
  "drying_temp": "55",             // recommended, from the RFID tag
  "drying_time": "8",
  "tray_uuid": "...",
  "tag_uid": "..."
}
```

An empty slot reports an empty `tray_type`.

`remain` alone is not enough to answer "is there enough filament for this plate" —
pair it with `tray_weight` (1000 g for a standard spool, 250 g for the small ones) and
compare against `used_g` from `slice_info.config`.

**The external spool** is a separate one-element array, `vir_slot`, with the same
shape and `id: "255"`. It is a valid print target — `ams_mapping` value **254** — but
it has no RFID, so `remain` is meaningless there.

#### Humidity

`ams.ams[n]` carries two humidity fields and they are *not* the same scale:

| Field | Meaning |
|---|---|
| `humidity` | Level 1–5 (BambuStudio's `m_humidity_level`) |
| `humidity_raw` | Percentage (`m_humidity_percent`) — this is what Studio displays |

`humidity_raw` reads `"0"` on this unit at all times, and Bambu Studio shows `0 %` for
it too, so `0` is a genuine reading rather than a missing value. Treat only a missing
or non-numeric field as unknown.

### 3.3b Capability bits — `fun`

`print.fun` is a hex string used as a bitfield. BambuStudio reads individual bits out
of it to decide which UI to offer. The ones it names:

| Bit | Meaning |
|---|---|
| 2 | 220 V machine |
| 6 / 7 | flow / PA calibration |
| 10 | motor noise calibration |
| 28 | internal timelapse |
| 39 | bed control over MQTT |
| 46 | cooling filter |
| 48 | external change assist |
| 49 | **object skipping** — see [§2.6](#26-skipping-an-object-mid-print) |
| 60 | nozzle rack |

Observed on this P2S: `fun = "29FD183FF9CB7"`.

### 3.3c Print stages — `stg_cur` and `stg`

Everything the machine does that is not "laying down plastic" is a numbered stage.

| Field | Meaning |
|---|---|
| `stg_cur` | The stage happening right now. **`-1` means no stage** (idle, or plain printing). |
| `stg` | The stages this job plans to go through, in order — sent once when the job starts. |

Observed on a normal P2S job:
`stg = [29, 2, 13, 11, 4, 8, 14, 3, 54, 1, 255, 51]` — cool chamber, preheat bed, home,
identify the plate, change filament, calibrate flow, wipe the nozzle, vibration
compensation, wait for bed temperature, bed level, (255), print calibration lines.
Values in `stg` that are not in the table below (`255` here) appear to be padding;
treat anything unmapped as unknown rather than dropping it.

`stg_cur` is worth surfacing because these stages are where the minutes go before the
first layer, and where a job sits when something needs a human — a progress bar alone
tells you nothing during them.

Numbering from BambuStudio's `Slic3r::get_stage_string`:

| # | Stage | # | Stage | # | Stage |
|--:|---|--:|---|--:|---|
| 0 | Printing | 26 | Paused — AMS offline | 52 | Auto check: material |
| 1 | Auto bed leveling | 27 | Paused — heatbreak fan slow | 53 | Live view camera calibration |
| 2 | Heatbed preheating | 28 | Paused — chamber temperature control fault | 54 | Waiting for heatbed to reach target temperature |
| 3 | Vibration compensation | 29 | Cooling chamber | 55 | Auto check: material position |
| 4 | Changing filament | 30 | Paused — G-code inserted by user | 56 | Cutting module offset calibration |
| 5 | M400 pause | 31 | Motor noise showoff | 57 | Measuring surface |
| 6 | Paused — filament ran out | 32 | Paused — nozzle clumping | 58 | Thermal preconditioning for first layer |
| 7 | Heating nozzle | 33 | Paused — cutter error | 59 | Homing blade holder |
| 8 | Calibrating dynamic flow | 34 | Paused — first layer error | 60 | Calibrating camera offset |
| 9 | Scanning bed surface | 35 | Paused — nozzle clog | 61 | Calibrating blade holder position |
| 10 | Inspecting first layer | 36 | Measuring motion precision | 62 | Hotend pick and place test |
| 11 | Identifying build plate type | 37 | Enhancing motion precision | 63 | Waiting for chamber temperature to equalize |
| 12 | Calibrating micro lidar | 38 | Measuring motion accuracy | 64 | Preparing hotend |
| 13 | Homing toolhead | 39 | Nozzle offset calibration | 65 | Calibrating nozzle-clumping detection position |
| 14 | Cleaning nozzle tip | 40 | High-temperature auto bed leveling | 66 | Purifying chamber air |
| 15 | Checking extruder temperature | 41 | Auto check: quick-release lever | 67 | Measuring rotary attachment |
| 16 | Paused by the user | 42 | Auto check: door and upper cover | 68 | Toolhead moves above the purge chute |
| 17 | Paused — front cover fell off | 43 | Laser calibration | 69 | Cooling down the nozzle |
| 18 | Calibrating micro lidar | 44 | Auto check: platform | 70 | Toolhead moves to the centre of the heatbed |
| 19 | Calibrating flow ratio | 45 | Confirming BirdsEye camera location | 71 | Active arc fitting |
| 20 | Paused — nozzle temperature fault | 46 | Calibrating BirdsEye camera | 72 | Hotend type detection |
| 21 | Paused — heatbed temperature fault | 47 | Auto bed leveling — phase 1 | 73 | Build plate alignment detection |
| 22 | Filament unloading | 48 | Auto bed leveling — phase 2 | 74 | Heatbed surface foreign object detection |
| 23 | Paused — step loss | 49 | Heating chamber | 75 | Heatbed underside foreign object detection |
| 24 | Filament loading | 50 | Adjusting heatbed temperature | 76 | Pre-extrusion before printing |
| 25 | Motor noise cancellation | 51 | Printing calibration lines | 77 | Preparing AMS |

Note 12 and 18 are both "calibrating micro lidar", and 36/38 are near-duplicates —
that is how the upstream table reads, not a transcription slip.

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

#### `basic-ftp` reuse breaks on Node 22 and later — pin Node 20

Measured 2026-09-01 against firmware 01.01.02.03, `basic-ftp` 5.3.1, identical code,
three runtimes, listing `/`:

| Runtime | Result |
|---|---|
| **Node 20.20.2** | **46 entries** |
| Node 22.23.2 | `522 SSL connection failed: session reuse required` |
| Node 24.20.0 | same |

**It is not a TLS-version problem**, which is the obvious wrong guess. Node 20 succeeds
with the data connection on TLSv1.3, and pinning `maxVersion: 'TLSv1.2'` (so control and
data both negotiate 1.2) does *not* rescue 22 or 24. The control session is also
retrievable on the failing versions — `socket.getSession()` returns 1855 bytes — so the
session object exists and is simply not being honoured for the data connection.

This is an awkward constraint: **Node 20 reached end-of-life on 2026-04-30**, so the only
runtime that can talk to the printer's FTPS is one that no longer receives security
patches. Anyone bumping the base image will find MQTT, the camera and the whole UI still
working while file listing, previews and uploads fail with a 502 — the failure is
confined to FTPS, so it is easy to miss in a smoke test. Check `/api/files`, not
`/api/health`.

### 5.2 Directory layout

| Path | Contents |
|---|---|
| `/` | Sliced `.gcode.3mf` models |
| `/timelapse` | Timelapse `.mp4` files plus a `thumbnail/` subdirectory |
| `/ipcam` | `ipcam-record.*.mp4` chunks (~268 MB each — these accumulate) |
| `/cache`, `/model`, `/image` | Usually empty |

### 5.3 Partial reads: `SIZE` and `REST` work, aborting does not

vsftpd answers `SIZE` on the control connection and honours `REST <offset>` before
`RETR`, so you can start a transfer at an arbitrary byte. That is enough to serve HTTP
`Range` requests, and enough to read a ZIP central directory without downloading the
archive.

What you **cannot** do is stop a transfer early. There is no "read N bytes then stop" —
`ABOR` is unreliable and leaves the control connection in a state you cannot trust.
The only dependable way to end a transfer you no longer want is to **destroy the
connection**. Count the bytes you need on the way out, then close the client.

Practical consequences:

- One FTP connection per byte range. A `<video>` seek is a new connection.
- Cap your concurrency. The printer does not have many connections to give, and a
  leaked one stays leaked until the socket times out.
- `SIZE` and `RETR` can share one connection, so a range read needs exactly one.

### 5.4 Inside a Bambu-sliced `.gcode.3mf`

A 3MF is an ordinary ZIP. A file sliced by Bambu Studio / Orca contains:

| Entry | Contents |
|---|---|
| `Metadata/plate_N.png` | Rendered preview of plate *N* — roughly 200 KB |
| `Metadata/plate_N_small.png` | Thumbnail-sized version of the same |
| `Metadata/plate_N.json` | Per-layer data |
| `Metadata/slice_info.config` | XML: print time, filament usage, objects, per plate |
| `3D/3dmodel.model` | The mesh, as 3MF XML — this is the large one |

`slice_info.config` looks like:

```xml
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="8130"/>       <!-- seconds -->
    <metadata key="weight" value="42.75"/>          <!-- grams -->
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="support_used" value="false"/>
    <metadata key="filament_maps" value="1 1 1 1"/>  <!-- project filament count -->
    <object identify_id="102" name="bracket.stl" skipped="false"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#2C2C2E"
              used_m="14.31" used_g="42.75"/>
    <warning msg="bed_temperature_too_high_than_filament" level="3"
             error_code="1000C001"/>
  </plate>
</config>
```

Three fields here are easy to miss and worth reading:

- **`filament_maps`** — the element count is the project's filament count, which is
  what `ams_mapping` must be sized to. See [§2.3](#23-starting-a-print-the-ams_mapping-trap).
- **`filament id` / `tray_info_idx`** — `id` is the project filament number (the
  `ams_mapping` index is `id - 1`); `tray_info_idx` matches the same field on AMS trays,
  which makes automatic tray selection a lookup rather than a guess.
- **`<warning>`** — the slicer's own warnings travel inside the file. Level 3 is what
  Bambu Studio shows in red. The same warning repeats once per object, so de-duplicate
  by `msg`. Surfacing these before a remote start is nearly free and catches things
  like a bed temperature above what the filament tolerates.

The plate PNG plus this file is everything a phone needs to identify a job. Reading it
costs two ranged FTP reads: one for the ZIP tail (which normally contains the whole
central directory) and one for the entry itself.

---

### 5.4b The end of a print: `M18`, and what that costs you

The P2S machine end G-code finishes with `M400` then **`M18` — steppers released**. There
is no `M84` and no `G28` anywhere in it. Two consequences worth knowing before building
anything that moves the toolhead after a job:

- Once a print ends, **position is gone**. Any later motion command has to be preceded by
  `G28`, and Z homing on this machine probes by touching the nozzle to the bed — with a
  finished part still sitting there, that is a collision, not a homing move.
- Anything that wants to move while the machine is still homed must run **inside the job**,
  before that `M18`.

`gcode_line` itself is accepted while idle: sending `M140 S30` with `gcode_state = FINISH`
moves `bed_target_temper` 0 → 30. So the command channel is not the constraint; the homing
state is.

**Verified on the machine (2026-09-02, empty bed):**

- A **multi-line** `gcode_line` payload is accepted while `gcode_state = IDLE`; the whole
  block runs. `G28`, `G0`, `G1`, `M17` all execute.
- **`home_flag` bits 0/1/2 track homing, but bit 0 is Z — not X.** A full `G28` walks the
  low nibble `…98` → `…9E` → `…9F`, which on its own looks like "one bit per axis in XYZ
  order". Sending `G28 X` alone settles the question: it sets bits 1 and 2 and leaves
  bit 0 clear. Since `G28 X` cannot have homed Z, **bit 0 is Z and bits 1/2 are X/Y**, and
  the full-`G28` progression is simply X/Y first, then Z — exactly the order the machine's
  own start G-code uses. All three clear means the steppers were released.
- **`G28 X` homes X *and* Y.** Two bits go high, not one. Verified independently by
  commanding `G1 X128 Y68` then `G1 X128 Y188` and watching the toolhead move between the
  two in the chamber camera.
- Homing takes roughly 30 s from cold.
- With the machine already homed, a sequence **without** `G28` moves immediately — which is
  the whole premise of injecting the block before `M18`.
- XY moves land where you ask. Commanding X=20 → X=220 → X=20 with everything else held
  constant flips the brightness of the top-right image segments (59 → 174 → 60) and reverses
  the sign of the change in 8 of 8 horizontal segments. Position is repeatable.

#### First run against a real part

A 69×79×40 mm hollow PLA pyramid, printed centred, bed allowed to fall to 28 °C (chamber
ambient — it will not go lower unaided), pushed at Z = 1 mm with `M17 X0.8 Y0.8 Z0.5`
wrapping only the push stroke:

- **The part released.** 28 °C was cold enough on a textured PEI plate; nothing had to be
  pried. So the cooling step is the load-bearing precondition it was assumed to be, and
  ambient is a workable target — you do not need the 25 °C the community G-code asks for.
- **It moved, then sprang back.** Watching at the machine — rather than inferring from
  the chamber camera — the mechanism is the **brim**, not tipping. This plate was sliced
  with `brim_type = outer_only`, `brim_width = 5`. A brim is one layer, roughly 0.2 mm, so
  a nozzle pushing at Z = 1 mm **passes clean over it and never touches it**. The brim is
  not pushed; it is dragged by the body it is fused to. Part of it tears free, part stays
  stuck, and the still-stuck remainder acts as a tether that pulls the body back.
- No error, no HMS entry, no audible stall.

So the rule that falls out: **auto-ejection wants no brim.** Prefer a part with enough
base area to hold on its own and slice it with `brim_type = no_brim`. Raising the push
height does not help — the brim is below any safe pushing height, and dropping the nozzle
to brim height means dragging it on the plate. Making the brim *taller* than the push
height would let the nozzle drive brim and body together, but Bambu Studio has no brim-height
setting, so treat that as a modelling trick rather than a slicer option.

`planEject` now emits a `hasBrim` warning whenever it is told the slice has one; the width
is readable from `project_settings.config`.

Still unverified: whether the reduced motor current actually skips steps rather than
shoving — this run never tested it, because the part came free. And `M190 R` vs `S`
semantics remain untested; this run deliberately did not rely on them, waiting for the
bed to cool out-of-band instead.

#### `G28` probes Z at the bed centre — which is where your part is

The machine's own start G-code gives the location away:

```gcode
G1 X128 Y128 F30000
G28 Z P0 T400
```

Two things follow. **`G28 Z` probes at the current XY** — the machine merely moves to the
centre out of habit. And a bare `G28` after a print will drive the nozzle down onto
whatever is sitting at (128, 128), which for a centred part is the part itself. A 69×79 mm
funnel printed in the middle of the plate covers that point completely.

The way out is to copy the machine's own sequence and change only the destination:

```gcode
G28 X                    ; X/Y only — the bed is still parked low, so travel clears the part
G1 X<clear> Y<clear> F6000
G28 Z P0                 ; probe here instead of the centre
```

Whether `G28 X` also homes Y is an inference from that same snippet, not something the
docs state. Worth confirming against `home_flag` bits 0/1 before relying on it — if Y is
left unhomed and the firmware still accepts the move, the probe lands somewhere you did
not choose.

---

### 5.5 Slicing an unsliced 3MF yourself

Files downloaded from MakerWorld and other model sites are usually *unsliced* — a mesh
with no `Metadata/plate_N.gcode`. The printer cannot start one, and `slice_info.config`
reports no filaments, so [§2.3](#23-starting-a-print-the-ams_mapping-trap)'s mapping has
nothing to size itself against.

Bambu Studio can slice these headlessly. This needs no cloud service: the Linux AppImage
runs on any always-on box you already have.

```
BambuStudio_ubuntu22.04-v02.08.02.61-*.AppImage   219 MB, 540 MB extracted
```

**Run it through `AppRun`, not `bin/bambu-studio`.** The AppImage bundles its own FFmpeg
libraries in `squashfs-root/bin/`, and only `AppRun` exports the `LD_LIBRARY_PATH` that
finds them. Calling the binary directly fails with `libavcodec.so.61: cannot open shared
object file` even though the library is sitting right next to it.

Headless is by design, not a workaround — `BambuStudio.cpp` decides with
`bool start_gui = m_actions.empty() && !downward_check;`, so passing `--slice` never
opens a window. No X server, no Xvfb.

System dependencies beyond the bundle: `libwebkit2gtk-4.1-0` (Debian 12 has it).
`LC_ALL=C` is required — `AppRun` sets it, and the CLI mis-parses numbers without it.

```sh
P=squashfs-root/resources/profiles/BBL
./squashfs-root/AppRun --slice 0   --load-settings "$P/machine/Bambu Lab P2S 0.4 nozzle.json;$P/process/0.20mm Standard @BBL P2S.json"   --load-filaments "$P/filament/Bambu PLA Basic @BBL P2S.json"   --outputdir out --export-3mf sliced.gcode.3mf model.3mf
```

**`--export-3mf` is relative to `--outputdir`, not to the cwd.** Passing `out/sliced.3mf`
alongside `--outputdir out` makes it write to `out/out/sliced.3mf`, which fails with
`Unable to open the file` — the directory is not created. Pass a bare filename.

P2S profiles ship in the AppImage: 4 machine files (0.2/0.4/0.6/0.8 nozzle) and 16
process files.

**Profile inheritance is resolved**, which is the part worth verifying rather than
assuming. The machine profile is only a diff — it carries `inherits:
fdm_bbl_3dp_001_common` and defines almost nothing itself. If the CLI ignored that, the
slice would silently use default bed dimensions and temperatures and produce a file that
prints but wrecks the machine. It does not; `project_settings.config` in the output has
`printable_area` 256×256, `printable_height` 256, PLA nozzle 220 °C, bed 55 °C.

Output on a 2-core container, 4.5 MB input: **~20 s**, `result.json` reporting
`"return_code": 0`. The `.gcode.3mf` is structurally complete — `plate_1.gcode` plus its
`.md5`, `plate_1.json`, the preview PNGs, and a `slice_info.config` carrying
`identify_id` per object (so [§2.6](#26-skipping-an-object-mid-print)'s metadata survives).

**Two fields the CLI leaves empty that Bambu Studio fills:**

| Field in `slice_info.config` | Studio | CLI | Where the value lives |
|---|---|---|---|
| `printer_model_id` | `N7` | *(empty)* | `machine/Bambu Lab P2S.json` → `model_id` |
| `tray_info_idx` | `GFA01` | *(empty)* | the filament profile → `filament_id` (PLA Basic = `GFA00`) |

**A third omission is more consequential: the machine end G-code is not applied.** A
CLI-sliced file ends with a generic three-line block:

```gcode
M104 S0 ; turn off temperature
G28 X0  ; home X axis
M84     ; disable motors
```

Bambu Studio emits the real P2S block instead — roughly 80 lines that pull the filament
back to the AMS (`M620 S65535` / `T65535` / `G150.2` / `M621 S65535`), close out a
timelapse, drop the Z motor current before lowering the bed, run the finish-air-purge,
play the completion tune, and end on `M18`. Print a CLI-sliced file as-is and **the
filament is never returned to the AMS**. The machine profile keeps these in sibling
`... template machine_end_gcode.json` files, which the CLI does not pull in when the
profile is passed by path.

Both metadata fields are constants readable from the same profile tree, so filling them
in afterwards is deterministic. `tray_info_idx` is what makes AMS tray selection a lookup instead of a
guess ([§5.4](#54-inside-a-bambu-sliced-gcode3mf)); an empty one degrades matching to
filament type alone. **Whether the printer rejects a file with an empty
`printer_model_id` has not been tested** — verifying it costs a real print.

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
