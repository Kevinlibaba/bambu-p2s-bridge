#!/usr/bin/env python3
"""
四份语言包的键结构必须完全一致。

漏一个键，在缺失的语言里会静默回落到英文（fallbackLocale），
界面上只是"某一行忽然变成英文"，很难被发现 —— 所以交给 CI 盯。

本地也可直接运行：python3 .github/scripts/check-i18n.py
"""
import json
import pathlib
import sys

LOCALE_DIR = pathlib.Path(__file__).resolve().parents[2] / "app" / "src" / "locale"
LOCALES = ["zh-Hans", "zh-Hant", "en", "ja"]
REFERENCE = "en"


def flatten(node, prefix=""):
    """把嵌套结构压成 'files.plate' 这样的路径集合。叶子必须是字符串。"""
    out = {}
    for key, value in node.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict):
            out.update(flatten(value, path + "."))
        else:
            out[path] = value
    return out


def main() -> int:
    keys = {}
    values = {}
    for loc in LOCALES:
        path = LOCALE_DIR / f"{loc}.json"
        if not path.exists():
            print(f"缺少语言包: {path}", file=sys.stderr)
            return 1
        flat = flatten(json.loads(path.read_text(encoding="utf-8")))
        keys[loc] = set(flat)
        values[loc] = flat

    findings = []
    reference = keys[REFERENCE]
    for loc in LOCALES:
        if loc == REFERENCE:
            continue
        for k in sorted(reference - keys[loc]):
            findings.append(f"{loc}.json 缺少键: {k}")
        for k in sorted(keys[loc] - reference):
            findings.append(f"{loc}.json 多出键: {k}（{REFERENCE}.json 里没有）")

    # 非字符串叶子会让 t() 返回对象，模板里直接渲染成 [object Object]
    for loc in LOCALES:
        for k, v in values[loc].items():
            if not isinstance(v, str):
                findings.append(f"{loc}.json 的 {k} 不是字符串")

    # 占位符不一致 —— {n} 写成 {count} 之类，运行时不会报错，只会渲染出空白
    for k in sorted(reference):
        want = {p for p in _placeholders(values[REFERENCE][k])}
        for loc in LOCALES:
            if loc == REFERENCE or k not in values[loc]:
                continue
            got = {p for p in _placeholders(values[loc][k])}
            if got != want:
                findings.append(
                    f"{loc}.json 的 {k} 占位符不一致: {sorted(got)} != {sorted(want)}"
                )

    if findings:
        print(f"发现 {len(findings)} 处语言包问题：\n", file=sys.stderr)
        for f in findings:
            print(f"  {f}", file=sys.stderr)
            print(f"::error::{f}")
        return 1

    print(f"{len(LOCALES)} 份语言包，各 {len(reference)} 个键，结构一致。")
    return 0


def _placeholders(text):
    import re

    return re.findall(r"\{(\w+)\}", text) if isinstance(text, str) else []


if __name__ == "__main__":
    sys.exit(main())
