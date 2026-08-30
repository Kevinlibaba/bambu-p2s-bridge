#!/usr/bin/env python3
import socket, ssl, struct, json, sys, time
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
    out=b""
    while True:
        d=n%128; n//=128
        if n: d|=0x80
        out+=bytes([d])
        if not n: return out
def enc_str(s):
    b=s.encode() if isinstance(s,str) else s
    return struct.pack("!H",len(b))+b
def read_len(k):
    m,v=1,0
    while True:
        b=k.recv(1)
        if not b: return None
        v+=(b[0]&127)*m; m*=128
        if not (b[0]&0x80): return v
def recvn(k,n):
    buf=b""
    while len(buf)<n:
        c=k.recv(n-len(buf))
        if not c: break
        buf+=c
    return buf
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
s=ctx.wrap_socket(socket.create_connection((HOST,8883),timeout=10),server_hostname=HOST)
body=enc_str("MQTT")+bytes([4,0xC2])+struct.pack("!H",60)+enc_str("probe3")+enc_str(USER)+enc_str(CODE)
s.sendall(bytes([0x10])+enc_len(len(body))+body); s.recv(1); read_len(s); recvn(s,2)
b=struct.pack("!H",1)+enc_str(f"device/{SN}/report")+bytes([0]); s.sendall(bytes([0x82])+enc_len(len(b))+b)
pl=json.dumps({"pushing":{"sequence_id":"9","command":"pushall"}}); bb=enc_str(f"device/{SN}/request")+pl.encode()
s.sendall(bytes([0x30])+enc_len(len(bb))+bb)
s.settimeout(20); end=time.time()+20; st={}
while time.time()<end:
    try:
        h=s.recv(1)
        if not h: break
        if h[0]>>4!=3:
            n=read_len(s); recvn(s,n); continue
        n=read_len(s); p=recvn(s,n); tl=struct.unpack("!H",p[:2])[0]
        m=json.loads(p[2+tl:])
        if "print" in m:
            st.update(m["print"])
            if len(st)>50 and "ipcam" in st: break
    except Exception: break
s.close()
for k in ("device","model_id","ipcam","net","xcam","cfg","fun","care","aux","job","file","upload","stg_cur","mc_stage"):
    if k in st:
        print(f"--- {k} ---")
        print(json.dumps(st[k],indent=2,ensure_ascii=False)[:1800]); print()
