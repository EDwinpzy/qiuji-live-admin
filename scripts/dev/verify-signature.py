#!/usr/bin/env python3
"""校验云端补货产出的票据签名（用 My TV 真公钥验收，与设备端同一口径）。

用法：在项目根目录执行
  python scripts/dev/verify-signature.py     # 校验 .dev-state/last-batch.json 记录的批次
"""
import base64
import json
import pathlib
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
PUB_PATH = pathlib.Path("D:/MyProjects/My TV/tools/keys/public_key.pem")
STATE = ROOT / ".dev-state"


def canonical(t: dict) -> str:
    return f"{t['v']}|{t['code']}|{t['plan']}|{t['days']}|{t['issued']}|{t['nonce']}"


def main() -> int:
    batch_file = STATE / "last-batch.json"
    if not batch_file.exists():
        sys.exit("找不到 .dev-state/last-batch.json（先跑一次 npm run smoke）")
    codes = json.loads(batch_file.read_text(encoding="utf-8"))["codes"]
    if not PUB_PATH.exists():
        sys.exit(f"找不到公钥 {PUB_PATH}")

    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    pub = serialization.load_pem_public_key(PUB_PATH.read_bytes())
    conn = sqlite3.connect(STATE / "d1.sqlite")
    ok = bad = 0
    for code in codes:
        row = conn.execute("SELECT ticket FROM licenses WHERE code = ?", (code,)).fetchone()
        if not row:
            print(f"  数据库中找不到 {code}")
            bad += 1
            continue
        ticket = json.loads(row[0])
        try:
            pub.verify(base64.b64decode(ticket["sig"]), canonical(ticket).encode(),
                       ec.ECDSA(hashes.SHA256()))
            ok += 1
        except InvalidSignature:
            print(f"  验签失败：{code}")
            bad += 1
    print(f"云端补货票据验签：通过 {ok} / 失败 {bad}（canonical 与设备端一致）")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
