#!/usr/bin/env python3
import ftplib, ssl, sys
import os

def _arg(i, env, hint):
    v = os.environ.get(env) or (sys.argv[i] if len(sys.argv) > i else None)
    if not v:
        sys.exit(f"用法: {sys.argv[0]} <printer-ip> <access-code>{hint}\n"
                 f"或设置环境变量 BAMBU_HOST / BAMBU_ACCESS_CODE / BAMBU_SERIAL")
    return v

HOST = _arg(1, "BAMBU_HOST", "")
CODE = _arg(2, "BAMBU_ACCESS_CODE", "")
class BambuFTPS(ftplib.FTP_TLS):
    """隐式 TLS(990) + 数据连接复用控制连接的 TLS session"""
    def __init__(self,*a,**k):
        self._sock=None; super().__init__(*a,**k)
    @property
    def sock(self): return self._sock
    @sock.setter
    def sock(self,v):
        if v is not None and not isinstance(v, ssl.SSLSocket):
            v = self.context.wrap_socket(v, server_hostname=self.host)
        self._sock = v
    def ntransfercmd(self, cmd, rest=None):
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            conn = self.context.wrap_socket(conn, server_hostname=self.host,
                                            session=self.sock.session)   # ← 关键
        return conn, size
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
f = BambuFTPS(context=ctx); f.connect(HOST, 990, timeout=15); f.login("bblp", CODE); f.prot_p()
print("FTPS:", f.getwelcome(), "\n")
for d in ("/", "/cache", "/timelapse", "/model", "/image", "/ipcam"):
    try:
        items=[]; f.retrlines(f"LIST {d}", items.append)
        print(f"--- {d}  ({len(items)} 项) ---")
        for line in items[:10]: print("   ", line)
        if len(items)>10: print(f"    ... 还有 {len(items)-10} 项")
    except Exception as e:
        print(f"--- {d} --- {e}")
    print()
f.quit()
