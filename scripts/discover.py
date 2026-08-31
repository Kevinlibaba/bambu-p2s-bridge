#!/usr/bin/env python3
"""
在局域网里找 Bambu 打印机。

打印机会往 239.255.255.250:2021 周期性广播 SSDP NOTIFY，里面带序列号、
型号和固件版本 —— 也就是部署时要填进 .env 的两项里的两项。剩下的
访问码印在打印机屏幕上，那个没法自动拿。

只用标准库，和 probes/ 下的脚本一样，装机时不需要先 pip install 任何东西。

用法：
    python3 scripts/discover.py            # 人看的输出
    python3 scripts/discover.py --json     # 脚本消费
"""
import argparse
import json
import select
import socket
import struct
import sys
import time

GROUP = "239.255.255.250"
# 打印机在 2021 上广播；M-SEARCH 两个端口都发一遍，不同固件表现不一致
PORTS = (1990, 2021)
ST = "urn:bambulab-com:device:3dprinter:1"

# 只写实测确认过的。其余机型照原样显示代号，好过给一张猜出来的对照表。
MODELS = {"N7": "P2S"}


def model_name(code: str) -> str:
    if not code:
        return "未知型号"
    return f"{MODELS[code]} ({code})" if code in MODELS else code


def discover(timeout: float = 6.0) -> list[dict]:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("", 2021))
        mreq = struct.pack("4sl", socket.inet_aton(GROUP), socket.INADDR_ANY)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    except OSError as e:
        print(f"无法监听 UDP 2021: {e}", file=sys.stderr)
        return []

    msearch = (
        f"M-SEARCH * HTTP/1.1\r\nHOST: {GROUP}:2021\r\n"
        f'MAN: "ssdp:discover"\r\nMX: 1\r\nST: {ST}\r\n\r\n'
    ).encode()
    for port in PORTS:
        try:
            s.sendto(msearch, (GROUP, port))
        except OSError:
            pass

    found: dict[str, dict] = {}
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([s], [], [], max(0.0, end - time.time()))
        if not r:
            break
        try:
            data, addr = s.recvfrom(4096)
        except OSError:
            break
        # 报文里的自定义头形如 `DevModel.bambu.com: N7`，
        # 归一化成小写并去掉 .bambu.com 后缀再取用
        info = {}
        for line in data.decode(errors="ignore").split("\r\n"):
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            key = k.strip().lower()
            if key.endswith(".bambu.com"):
                key = key[: -len(".bambu.com")]
            info[key] = v.strip()
        serial = info.get("usn", "").strip()
        if not serial:
            continue
        found[addr[0]] = {
            "ip": info.get("location", addr[0]).strip() or addr[0],
            "serial": serial,
            "model": info.get("devmodel", ""),
            "name": info.get("devname", ""),
            "version": info.get("devversion", ""),
        }
    s.close()
    return list(found.values())


def main() -> int:
    ap = argparse.ArgumentParser(description="在局域网里找 Bambu 打印机")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出，供脚本消费")
    ap.add_argument("--timeout", type=float, default=6.0, help="监听秒数，默认 6")
    args = ap.parse_args()

    printers = discover(args.timeout)
    if args.json:
        print(json.dumps(printers, ensure_ascii=False))
        return 0 if printers else 1

    if not printers:
        print("没有发现打印机。")
        print("常见原因：这台机器和打印机不在同一个二层网络，")
        print("或者路由器开了组播隔离（AP isolation / IGMP snooping）。")
        print("知道 IP 的话，手动填进 .env 即可，不影响后续步骤。")
        return 1

    for p in printers:
        print(f"{p['ip']}  {model_name(p['model'])}  序列号 {p['serial']}"
              + (f"  固件 {p['version']}" if p["version"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
