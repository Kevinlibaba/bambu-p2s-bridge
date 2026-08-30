#!/usr/bin/env python3
"""
拦截凭据进入版本库。

凭据只应存在于 .env（不入库）。这里扫描所有被 git 跟踪的文件。
本地也可直接运行：python3 .github/scripts/check-secrets.py
"""
import re
import subprocess
import sys

# 明显是占位符的取值，不算泄漏
PLACEHOLDER = re.compile(
    r"^\s*$"                      # 空
    r"|^[xX]+$"                   # xxxxxxxx
    r"|^<.+>$"                    # <ACCESS_CODE>
    r"|^\$\{.+\}$"                # ${BAMBU_ACCESS_CODE}
    r"|^(your|my|example|changeme|placeholder|redacted|todo)",
)

# 除了匹配位置，取值还必须"长得像真凭据"，否则说明文字会被误伤
#   README 里的 "API_TOKEN: openssl rand -hex 24"
#   .env.example 里的 "BAMBU_ACCESS_CODE=xxxxxxxx"
LOOKS_LIKE_ACCESS_CODE = re.compile(r"^[0-9a-zA-Z]{8}$")
LOOKS_LIKE_TOKEN = re.compile(r"^(?:[0-9a-fA-F]{16,}|[A-Za-z0-9_\-]{24,})$")

CHECKS = [
    (
        "硬编码访问码",
        re.compile(r"BAMBU_ACCESS_CODE\s*[=:]\s*(?P<v>[^\s\"'#]+)"),
        LOOKS_LIKE_ACCESS_CODE.match,
    ),
    (
        "硬编码 API token",
        re.compile(r"API_TOKEN\s*[=:]\s*(?P<v>[^\s\"'#]+)"),
        LOOKS_LIKE_TOKEN.match,
    ),
    (
        "真实 tailnet 域名",
        # 真实 tailnet 形如 host.tailXXXXXX.ts.net；
        # 文档里写 *.ts.net / your-tailnet.ts.net 属于说明文字，不拦。
        re.compile(r"(?P<v>\b[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net\b)"),
        None,
    ),
    (
        "真实打印机地址",
        # 私网 IP 后直接跟打印机端口，基本可以确定是真机地址
        re.compile(r"(?P<v>\b(?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}:(?:8883|990|322|6000)\b)"),
        None,
    ),
    (
        "Tailscale 100.64/10 地址",
        re.compile(r"(?P<v>\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b)"),
        None,
    ),
]

BINARY_SUFFIX = (".png", ".jpg", ".jpeg", ".gif", ".ico", ".zst", ".woff", ".woff2")


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], capture_output=True, text=True, check=True
    ).stdout
    return [f for f in out.split("\0") if f and not f.lower().endswith(BINARY_SUFFIX)]


def main() -> int:
    findings: list[str] = []
    for path in tracked_files():
        try:
            with open(path, encoding="utf-8") as fh:
                lines = fh.readlines()
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        for lineno, line in enumerate(lines, 1):
            for label, pattern, looks_real in CHECKS:
                for m in pattern.finditer(line):
                    value = m.group("v")
                    if PLACEHOLDER.match(value):
                        continue
                    if looks_real and not looks_real(value):
                        continue
                    findings.append(f"{path}:{lineno}  {label}: {value}")

    if findings:
        print(f"发现 {len(findings)} 处疑似凭据：\n", file=sys.stderr)
        for f in findings:
            print(f"  {f}", file=sys.stderr)
            print(f"::error file={f.split(':')[0]}::{f}")
        print(
            "\n凭据只应放在 .env（已被 .gitignore 排除）。"
            "文档里请用 <PRINTER_IP> / <ACCESS_CODE> 这类占位符。",
            file=sys.stderr,
        )
        return 1

    print(f"已扫描 {len(tracked_files())} 个跟踪文件，未发现凭据。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
