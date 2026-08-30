#!/usr/bin/env python3
"""Bambu Lab LAN 协议探针 — 纯标准库，不装任何依赖"""
import socket, ssl, struct, json, sys, time, select
import os

def _arg(i, env, hint):
    v = os.environ.get(env) or (sys.argv[i] if len(sys.argv) > i else None)
    if not v:
        sys.exit(f"用法: {sys.argv[0]} <printer-ip> <access-code>{hint}\n"
                 f"或设置环境变量 BAMBU_HOST / BAMBU_ACCESS_CODE / BAMBU_SERIAL")
    return v


HOST = _arg(1, "BAMBU_HOST", "")
CODE = _arg(2, "BAMBU_ACCESS_CODE", "")
USER = "bblp"

# ---------- 1. SSDP 发现：拿序列号 / 型号 / 固件版本 ----------
def ssdp_discover(timeout=8):
    print("=" * 60)
    print("【1】SSDP 发现 (UDP 2021)")
    print("=" * 60)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("", 2021))
        mreq = struct.pack("4sl", socket.inet_aton("239.255.255.250"), socket.INADDR_ANY)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    except Exception as e:
        print(f"  bind 失败: {e}")
        return None
    msearch = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:2021\r\n"
               'MAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:bambulab-com:device:3dprinter:1\r\n\r\n')
    for port in (1990, 2021):
        try: s.sendto(msearch.encode(), ("239.255.255.250", port))
        except Exception: pass
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([s], [], [], end - time.time())
        if not r: break
        data, addr = s.recvfrom(4096)
        if addr[0] != HOST: continue
        info = {}
        for line in data.decode(errors="ignore").split("\r\n"):
            if ":" in line:
                k, v = line.split(":", 1)
                info[k.strip().lower()] = v.strip()
        print(f"  来自 {addr[0]}:")
        for k in ("usn", "devmodel", "devname", "devversion", "devsignal", "devconnect", "devbind"):
            if k in info: print(f"    {k:12s} = {info[k]}")
        if info.get("usn"): return info
    print("  未收到 SSDP 广播（可能被路由器隔离了组播）")
    return None

# ---------- 极简 MQTT 3.1.1 ----------
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
        val += (b[0] & 127) * mult
        mult *= 128
        if not (b[0] & 0x80): return val

def recvn(sock, n):
    buf = b""
    while len(buf) < n:
        c = sock.recv(n - len(buf))
        if not c: break
        buf += c
    return buf

def mqtt_probe(serial, timeout=25):
    print()
    print("=" * 60)
    print(f"【2】MQTT (8883) — serial={serial or '未知，用通配符'}")
    print("=" * 60)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    raw = socket.create_connection((HOST, 8883), timeout=10)
    s = ctx.wrap_socket(raw, server_hostname=HOST)
    cert = s.getpeercert(binary_form=True)
    import hashlib
    print(f"  TLS 证书 SHA256 指纹: {hashlib.sha256(cert).hexdigest()[:32]}...")
    print(f"  TLS 版本: {s.version()}")

    body = (enc_str("MQTT") + bytes([4, 0xC2]) + struct.pack("!H", 60)
            + enc_str("probe-" + str(int(time.time()))) + enc_str(USER) + enc_str(CODE))
    s.sendall(bytes([0x10]) + enc_len(len(body)) + body)
    hdr = s.recv(1)
    if not hdr or hdr[0] != 0x20:
        print(f"  ✗ 未收到 CONNACK (got {hdr!r})"); return None
    read_len(s); ack = recvn(s, 2)
    codes = {0: "成功", 1: "协议版本不支持", 2: "client id 被拒", 3: "服务不可用",
             4: "用户名或访问码错误", 5: "未授权"}
    print(f"  CONNACK: {codes.get(ack[1], ack[1])}")
    if ack[1] != 0: return None

    topic = f"device/{serial}/report" if serial else "device/+/report"
    body = struct.pack("!H", 1) + enc_str(topic) + bytes([0])
    s.sendall(bytes([0x82]) + enc_len(len(body)) + body)
    print(f"  已订阅 {topic}")

    if serial:
        req = f"device/{serial}/request"
        pl = json.dumps({"pushing": {"sequence_id": "1", "command": "pushall"}})
        body = enc_str(req) + pl.encode()
        s.sendall(bytes([0x30]) + enc_len(len(body)) + body)
        print(f"  已发送 pushall")

    s.settimeout(timeout)
    end, got = time.time() + timeout, []
    while time.time() < end:
        try:
            b = s.recv(1)
            if not b: break
            if b[0] >> 4 != 3:
                n = read_len(s); recvn(s, n); continue
            n = read_len(s); payload = recvn(s, n)
            tl = struct.unpack("!H", payload[:2])[0]
            tp = payload[2:2+tl].decode(errors="ignore")
            msg = payload[2+tl:]
            try: got.append((tp, json.loads(msg)))
            except Exception: got.append((tp, msg[:200]))
            if len(got) >= 3: break
        except socket.timeout: break
        except Exception as e:
            print(f"  recv 错误: {e}"); break
    s.close()
    print(f"  收到 {len(got)} 条消息")
    return got

# ---------- 3. 摄像头端口 ----------
def camera_probe():
    print()
    print("=" * 60)
    print("【3】摄像头 — 322 (RTSPS) vs 6000 (私有协议)")
    print("=" * 60)
    for port, name in ((322, "RTSPS"), (6000, "私有")):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
        try:
            raw = socket.create_connection((HOST, port), timeout=6)
            s = ctx.wrap_socket(raw, server_hostname=HOST)
            print(f"  :{port} ({name}) TLS 握手成功, {s.version()}")
            if port == 322:
                req = (f"OPTIONS rtsps://{HOST}:322/streaming/live/1 RTSP/1.0\r\n"
                       "CSeq: 1\r\nUser-Agent: probe\r\n\r\n")
                s.sendall(req.encode()); s.settimeout(6)
                resp = s.recv(2048).decode(errors="ignore")
                print("    " + resp.strip().replace("\r\n", "\n    ")[:400])
            else:
                pkt = (struct.pack("<IIII", 0x40, 0x3000, 0, 0)
                       + USER.encode().ljust(32, b"\x00") + CODE.encode().ljust(32, b"\x00"))
                s.sendall(pkt); s.settimeout(8)
                data = s.recv(4096)
                print(f"    鉴权后收到 {len(data)} 字节, 头16字节: {data[:16].hex()}")
                if b"\xff\xd8" in data[:64]:
                    print("    ✓ 检测到 JPEG SOI (FFD8) — 私有协议可用")
            s.close()
        except Exception as e:
            print(f"  :{port} ({name}) 失败: {type(e).__name__}: {e}")

if __name__ == "__main__":
    info = ssdp_discover()
    serial = info.get("usn") if info else None
    msgs = mqtt_probe(serial)
    if msgs:
        for tp, m in msgs[:1]:
            print(f"\n  --- {tp} 首条消息结构 ---")
            print(json.dumps(m, indent=2, ensure_ascii=False)[:3000])
    camera_probe()
