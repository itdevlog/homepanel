#!/bin/sh
#
# Проверка применения control и команд агента (план router-v2, Task 8).
# Требует: ucode, python3 (фальшивый сервер). Выполняется локально.
#
set -u

TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
AGENT=${HOMEPANEL_AGENT:-$TESTS_DIR/../files/usr/share/ucode/homepanel/agent.uc}
FIXTURES=$TESTS_DIR/fixtures
NOW=1760000300
FAILED=0

fail() {
	echo "FAIL: $*"
	FAILED=1
}

if [ ! -f "$AGENT" ]; then
	echo "FAIL: agent not found: $AGENT"
	exit 1
fi
command -v ucode >/dev/null 2>&1 || { echo "FAIL: ucode not found in PATH"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 not found (нужен фальшивый сервер)"; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
CALLS="$WORK/calls"
mkdir -p "$BIN"
: > "$CALLS"

cat > "$BIN/nft" <<EOF
#!/bin/sh
echo "nft \$*" >> "$CALLS"
exit 0
EOF
cat > "$BIN/ubus" <<EOF
#!/bin/sh
echo "ubus \$*" >> "$CALLS"
exit 0
EOF
chmod +x "$BIN/nft" "$BIN/ubus"

free_port() {
	python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

write_cfg() { # $1 = server_url
	python3 - "$WORK/config.json" "$1" <<'PY'
import json, sys
path, url = sys.argv[1], sys.argv[2]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"enabled": True, "server_url": url, "secret": "s3cr3t",
               "interval": 30}, fh)
PY
}

start_server() { # $1 = mode, $2 = log
	PORT=$(free_port)
	python3 "$TESTS_DIR/fake_server.py" "$PORT" "$1" "$2" 1 &
	SRV=$!
	sleep 0.4
	write_cfg "http://127.0.0.1:$PORT"
}

run_agent() { # $1 = stdout, $2 = stderr
	ucode "$AGENT" --once --send --config-json "$WORK/config.json" \
		--status "$WORK/status" --ubus-dir "$FIXTURES" \
		--leases "$FIXTURES/dhcp.leases" --now "$NOW" \
		--nft "$BIN/nft" --ubus "$BIN/ubus" \
		>"$1" 2>"$2"
}

# --- первый прогон: сервер отдаёт паузу и команду kick -----------------
start_server control "$WORK/log1.jsonl"
run_agent "$WORK/out1" "$WORK/err1" || fail "agent exited non-zero (first run)"
wait $SRV 2>/dev/null

grep -q 'nft delete table inet homepanel' "$CALLS" || fail "nft table was not reset"
grep -q 'nft add element inet homepanel paused { 11:22:33:44:55:66 }' "$CALLS" ||
	fail "paused MAC was not added to nft set"
grep -q 'ubus call phy1-ap0 del_client' "$CALLS" || fail "kick was not sent via ubus"

python3 - "$WORK/status" <<'PY' || fail "status after first run is wrong"
import json, sys
st = json.load(open(sys.argv[1], encoding="utf-8"))
assert st["configured"] is True, st
assert st["ok"] is True, st
PY

[ -f "$WORK/status.acks.json" ] || fail "ack was not queued"

# --- второй прогон: сервер отвечает ok, агент присылает acks -----------
BEFORE=$(wc -l < "$CALLS")
start_server ok "$WORK/log2.jsonl"
run_agent "$WORK/out2" "$WORK/err2" || fail "agent exited non-zero (second run)"
wait $SRV 2>/dev/null

python3 - "$WORK/log2.jsonl" <<'PY' || fail "second request does not carry the ack"
import json, sys
lines = [line for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
assert lines, "no request logged"
body = json.loads(json.loads(lines[-1])["body"])
acks = body.get("acks") or []
assert any(a.get("id") == 7 and a.get("ok") is True for a in acks), acks
PY

AFTER=$(wc -l < "$CALLS")
[ "$BEFORE" = "$AFTER" ] || fail "kick was repeated on the second run"
[ ! -f "$WORK/status.acks.json" ] || fail "acks file was not removed after success"

if [ "$FAILED" -ne 0 ]; then
	echo "RESULT: FAIL"
	exit 1
fi

echo "RESULT: PASS"
