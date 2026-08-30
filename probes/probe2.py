#!/usr/bin/env python3
import socket, ssl, struct, json, sys, time, base64
import os

def _arg(i, env, hint):
    v = os.environ.get(env) or (sys.argv[i] if len(sys.argv) > i else None)
    if not v:
        sys.exit(f"用法: {sys.argv[0]} <printer-ip> <access-code>{hint}\n"
                 f"或设置环境变量 BAMBU_HOST / BAMBU_ACCESS_CODE / BAMBU_SERIAL")
    return v


HOST = _arg(1, "BAMBU_HOST", " <serial>")
CODE = _arg(2, "BAMBU_ACCESS_CODE", " <serial>")
SN   = _arg(3, "BAMBU_SERIAL", " <serial>")
USER = "bblp"

def enc_len(n):
    out = b""
    while True:
        d = n % 128; n //= 128
        if n: d |= 0x80
        out += bytes([d])
        if not n: return out
def enc_str(s):
    b = s.encode() if isinstance(s, str) else s
    return struct.pack("!H", len(b)) + b
def read_len(sock):
    mult, val = 1, 0
    while True:
        b = sock.recv(1)
        if not b: return None
        val += (b[0] & 127) * mult; mult *= 128
        if not (b[0] & 0x80): return val
def recvn(sock, n):
    buf = b""
    while len(buf) < n:
        c = sock.recv(n - len(buf))
        if not c: break
        buf += c
    return buf

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
s = ctx.wrap_socket(socket.create_connection((HOST,8883),timeout=10), server_hostname=HOST)
body = enc_str("MQTT")+bytes([4,0xC2])+struct.pack("!H",60)+enc_str("probe2")+enc_str(USER)+enc_str(CODE)
s.sendall(bytes([0x10])+enc_len(len(body))+body); s.recv(1); read_len(s); recvn(s,2)
b = struct.pack("!H",1)+enc_str(f"device/{SN}/report")+bytes([0])
s.sendall(bytes([0x82])+enc_len(len(b))+b)

def pub(obj):
    pl = json.dumps(obj); bb = enc_str(f"device/{SN}/request")+pl.encode()
    s.sendall(bytes([0x30])+enc_len(len(bb))+bb)

pub({"info":{"sequence_id":"2","command":"get_version"}})
time.sleep(1)
pub({"pushing":{"sequence_id":"3","command":"pushall"}})

s.settimeout(20); end=time.time()+20; state={}; ver=None
while time.time()<end:
    try:
        h = s.recv(1)
        if not h: break
        if h[0]>>4 != 3:
            n=read_len(s); recvn(s,n); continue
        n=read_len(s); p=recvn(s,n); tl=struct.unpack("!H",p[:2])[0]
        m=json.loads(p[2+tl:])
        if "info" in m and "module" in m.get("info",{}): ver=m["info"]
        if "print" in m:
            state.update(m["print"])
            if "nozzle_temper" in m["print"] and len(state)>50: break
    except Exception: break
s.close()

print("="*60); print("【固件 / 模块版本】"); print("="*60)
if ver:
    for mod in ver.get("module",[]):
        print(f"  {mod.get('name',''):16s} sn={mod.get('sn','')[:20]:22s} hw={mod.get('hw_ver',''):8s} sw={mod.get('sw_ver','')}")
else: print("  未取到 get_version 响应")

print(); print("="*60); print("【关键状态字段】"); print("="*60)
keys = ["gcode_state","mc_percent","mc_remaining_time","layer_num","total_layer_num",
        "nozzle_temper","nozzle_target_temper","bed_temper","bed_target_temper",
        "chamber_temper","spd_lvl","spd_mag","wifi_signal","gcode_file","subtask_name",
        "print_type","nozzle_diameter","nozzle_type","cooling_fan_speed","big_fan1_speed",
        "big_fan2_speed","heatbreak_fan_speed","sdcard","lights_report","hms","home_flag",
        "print_error","total_layer_num","ams_status","ams_rfid_status","fail_reason"]
for k in keys:
    if k in state: print(f"  {k:22s} = {json.dumps(state[k],ensure_ascii=False)}")
print(f"\n  [顶层字段总数] {len(state)}")
print(f"  [全部字段名] {', '.join(sorted(state.keys()))}")
