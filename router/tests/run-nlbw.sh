#!/bin/sh
set -u
TESTS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENT=${HOMEPANEL_AGENT:-"$TESTS_DIR/../files/usr/share/ucode/homepanel/agent.uc"}
UCODE=${UCODE:-ucode}

OUT=$("$UCODE" "$AGENT" --once --ubus-dir /nonexistent --leases /dev/null \
  --now 1760000300 --loadavg "$TESTS_DIR/fixtures/loadavg.txt" \
  --nlbw "$TESTS_DIR/fixtures/nlbw.json" 2>/dev/null)

printf '%s' "$OUT" | python3 -c '
import json, sys
data = json.load(sys.stdin)
block = data.get("nlbw") or {}
mac = block.get("aa:bb:cc:dd:ee:20") or {}
assert mac.get("rx_bytes") == 1234, mac
assert mac.get("tx_bytes") == 5678, mac
print("RESULT: PASS")
'
