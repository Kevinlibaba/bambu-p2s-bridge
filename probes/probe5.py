#!/usr/bin/env python3
import socket, ssl, sys, hashlib, re
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
URL = f"rtsps://{HOST}:322/streaming/live/1"
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
s = ctx.wrap_socket(socket.create_connection((HOST,322),timeout=8), server_hostname=HOST)
def md5(x): return hashlib.md5(x.encode()).hexdigest()
def send(raw):
    s.sendall(raw.encode()); s.settimeout(8); buf=b""
    while b"\r\n\r\n" not in buf:
        c=s.recv(4096)
        if not c: break
        buf+=c
    head,_,rest = buf.partition(b"\r\n\r\n")
    m=re.search(rb"Content-Length: (\d+)",head,re.I)
    if m:
        need=int(m.group(1))
        while len(rest)<need:
            c=s.recv(4096)
            if not c: break
            rest+=c
    return head.decode(errors="ignore"), rest.decode(errors="ignore")

h,_ = send(f"DESCRIBE {URL} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n")
realm = re.search(r'realm="([^"]+)"', h).group(1)
nonce = re.search(r'nonce="([^"]+)"', h).group(1)
ha1, ha2 = md5(f"{USER}:{realm}:{CODE}"), md5(f"DESCRIBE:{URL}")
resp = md5(f"{ha1}:{nonce}:{ha2}")
dig = (f'Digest username="{USER}", realm="{realm}", nonce="{nonce}", uri="{URL}", response="{resp}"')
h,b = send(f"DESCRIBE {URL} RTSP/1.0\r\nCSeq: 2\r\nAuthorization: {dig}\r\nAccept: application/sdp\r\n\r\n")
print("=== DESCRIBE (Digest) ==="); print(h.strip())
print("\n=== SDP ==="); print(b.strip() if b.strip() else "(空)")
