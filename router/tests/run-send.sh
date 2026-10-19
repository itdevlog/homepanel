#!/bin/sh
#
# Проверка отправки снимка агентом (плана Task 2).
# Требует: ucode, python3 (для фальшивого сервера). Выполняется локально.
#
set -u

TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
AGENT=${HOMEPANEL_AGENT:-$TESTS_DIR/../files/usr/share/ucode/homepanel/agent.uc}
FIXTURES=$TESTS_DIR/fixtures
EXPECTED=$TESTS_DIR/expected-snapshot.json
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

free_port() {
	python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

write_cfg() { # $1 = server_url, $2 = secret
	python3 - "$WORK/config.json" "$1" "$2" <<'PY'
import json, sys
path, url, secret = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"enabled": True, "server_url": url, "secret": secret,
               "interval": 30}, fh)
PY
}

run_send() { # $1 = status path
	ucode "$AGENT" --once --send \
		--config-json "$WORK/config.json" --status "$1" \
		--ubus-dir "$FIXTURES" --leases "$FIXTURES/dhcp.leases" --now "$NOW"
}

check_status() { # $1 = status path  $2 = python-выражение над полем data
	python3 - "$1" "$2" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as exc:
    print("FAIL: status file unreadable: %s" % exc); sys.exit(1)
if not eval(sys.argv[2], {}, {"data": data}):
    print("FAIL: status assertion %r failed for %r" % (sys.argv[2], data)); sys.exit(1)
PY
	[ $? -eq 0 ] || FAILED=1
}

# --- 1: успешная отправка -------------------------------------------------
PORT=$(free_port)
LOG=$WORK/req.json
STATUS=$WORK/status-ok.json
python3 "$TESTS_DIR/fake_server.py" "$PORT" ok "$LOG" &
SRV=$!
sleep 0.4
write_cfg "http://127.0.0.1:$PORT/api/ingest" "test"
if run_send "$STATUS" >"$WORK/out1" 2>"$WORK/err1"; then
	echo "PASS [ok] exit 0"
else
	fail "ok: exit code $? (expected 0); stderr: $(cat "$WORK/err1")"
fi
wait "$SRV" 2>/dev/null

python3 - "$LOG" "$EXPECTED" <<'PY'
import json, sys
try:
    rec = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as exc:
    print("FAIL: request not received: %s" % exc); sys.exit(1)
exp = json.load(open(sys.argv[2], encoding="utf-8"))
ok = True
if rec["method"] != "POST": ok = False; print("FAIL: method %r" % rec["method"])
if rec["path"] != "/api/ingest": ok = False; print("FAIL: path %r" % rec["path"])
if rec["headers"].get("x-homepanel-key") != "test": ok = False; print("FAIL: key header %r" % rec["headers"].get("x-homepanel-key"))
if "application/json" not in rec["headers"].get("content-type", ""): ok = False; print("FAIL: content-type %r" % rec["headers"].get("content-type"))
body = json.loads(rec["body"])
if body.get("schema") != 1: ok = False; print("FAIL: schema %r" % body.get("schema"))
if body.get("clients") != exp: ok = False; print("FAIL: clients mismatch: %r" % body.get("clients"))
print("PASS [request]" if ok else "FAIL [request]")
sys.exit(0 if ok else 1)
PY
[ $? -eq 0 ] || FAILED=1
check_status "$STATUS" 'data["configured"] is True and data["ok"] is True and data["client_count"] == 2 and data["version"] == "1.0" and data["last_error"] is None and data["last_send"] == 1760000300'
[ $FAILED -eq 0 ] && echo "PASS [status ok]"

# --- 2: сервер недоступен -------------------------------------------------
PORT=$(free_port)
STATUS=$WORK/status-down.json
write_cfg "http://127.0.0.1:$PORT/api/ingest" "test"
if run_send "$STATUS" >"$WORK/out2" 2>"$WORK/err2"; then
	echo "PASS [down] exit 0"
else
	fail "down: exit code $? (expected 0)"
fi
check_status "$STATUS" 'data["configured"] is True and data["ok"] is False and data["last_error"] and data["last_send"] is None'
[ $FAILED -eq 0 ] && echo "PASS [status down]"

# --- 3: не настроено ------------------------------------------------------
STATUS=$WORK/status-unset.json
write_cfg "" ""
if run_send "$STATUS" >"$WORK/out3" 2>"$WORK/err3"; then
	echo "PASS [unset] exit 0"
else
	fail "unset: exit code $? (expected 0)"
fi
check_status "$STATUS" 'data["configured"] is False and data["ok"] is False and data["last_send"] is None'
[ $FAILED -eq 0 ] && echo "PASS [status unset]"

# --- 4: некорректный ответ сервера ---------------------------------------
PORT=$(free_port)
LOG=$WORK/req4.json
STATUS=$WORK/status-bad.json
python3 "$TESTS_DIR/fake_server.py" "$PORT" error "$LOG" &
SRV=$!
sleep 0.4
write_cfg "http://127.0.0.1:$PORT/api/ingest" "test"
if run_send "$STATUS" >"$WORK/out4" 2>"$WORK/err4"; then
	echo "PASS [bad-response] exit 0"
else
	fail "bad-response: exit code $? (expected 0)"
fi
wait "$SRV" 2>/dev/null
check_status "$STATUS" 'data["configured"] is True and data["ok"] is False and data["last_error"]'
[ $FAILED -eq 0 ] && echo "PASS [status bad-response]"

# --- 5: 200 с ok=false в теле --------------------------------------------
PORT=$(free_port)
LOG=$WORK/req5.json
STATUS=$WORK/status-jsonfail.json
python3 "$TESTS_DIR/fake_server.py" "$PORT" jsonfail "$LOG" &
SRV=$!
sleep 0.4
write_cfg "http://127.0.0.1:$PORT/api/ingest" "test"
if run_send "$STATUS" >"$WORK/out5" 2>"$WORK/err5"; then
	echo "PASS [jsonfail] exit 0"
else
	fail "jsonfail: exit code $? (expected 0)"
fi
wait "$SRV" 2>/dev/null
check_status "$STATUS" 'data["configured"] is True and data["ok"] is False and data["last_error"]'
[ $FAILED -eq 0 ] && echo "PASS [status jsonfail]"

# --- 6: 200 с не-JSON телом ----------------------------------------------
PORT=$(free_port)
LOG=$WORK/req6.json
STATUS=$WORK/status-junk.json
python3 "$TESTS_DIR/fake_server.py" "$PORT" junk "$LOG" &
SRV=$!
sleep 0.4
write_cfg "http://127.0.0.1:$PORT/api/ingest" "test"
if run_send "$STATUS" >"$WORK/out6" 2>"$WORK/err6"; then
	echo "PASS [junk] exit 0"
else
	fail "junk: exit code $? (expected 0)"
fi
wait "$SRV" 2>/dev/null
check_status "$STATUS" 'data["configured"] is True and data["ok"] is False and data["last_error"]'
[ $FAILED -eq 0 ] && echo "PASS [status junk]"

# --- 7: демон-цикл (несколько тиков подряд) ------------------------------
PORT=$(free_port)
LOG=$WORK/req7.jsonl
STATUS=$WORK/status-daemon.json
python3 "$TESTS_DIR/fake_server.py" "$PORT" ok "$LOG" 6 &
SRV=$!
sleep 0.4
write_cfg "http://127.0.0.1:$PORT/api/ingest" "test"
ucode "$AGENT" --interval 1 \
	--config-json "$WORK/config.json" --status "$STATUS" \
	--ubus-dir "$FIXTURES" --leases "$FIXTURES/dhcp.leases" \
	>"$WORK/out7" 2>"$WORK/err7" &
AGENT_PID=$!
sleep 4
kill "$AGENT_PID" 2>/dev/null
wait "$AGENT_PID" 2>/dev/null
kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null

TICKS=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ')
TICKS=${TICKS:-0}
if [ "$TICKS" -ge 2 ]; then
	echo "PASS [daemon ticks=$TICKS]"
else
	fail "daemon: got $TICKS requests (expected >= 2); stderr: $(cat "$WORK/err7")"
fi
check_status "$STATUS" 'data["configured"] is True and data["ok"] is True and data["client_count"] == 2 and data["last_send"]'
[ $FAILED -eq 0 ] && echo "PASS [status daemon]"

# --- 8: секрет с одинарной кавычкой не ломает команду --------------------
PORT=$(free_port)
LOG=$WORK/req8.json
STATUS=$WORK/status-quote.json
python3 "$TESTS_DIR/fake_server.py" "$PORT" ok "$LOG" &
SRV=$!
sleep 0.4
write_cfg "http://127.0.0.1:$PORT/api/ingest" "se'cr\"et\$x"
if run_send "$STATUS" >"$WORK/out8" 2>"$WORK/err8"; then
	echo "PASS [quote] exit 0"
else
	fail "quote: exit code $? (expected 0)"
fi
wait "$SRV" 2>/dev/null
python3 - "$LOG" <<'PY'
import json, sys
try:
    rec = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as exc:
    print("FAIL: request not received: %s" % exc); sys.exit(1)
key = rec["headers"].get("x-homepanel-key")
ok = key == 'se\'cr"et$x'
print("PASS [quote header]" if ok else "FAIL: key header %r" % key)
sys.exit(0 if ok else 1)
PY
[ $? -eq 0 ] || FAILED=1
check_status "$STATUS" 'data["configured"] is True and data["ok"] is True and data["last_error"] is None'
[ $FAILED -eq 0 ] && echo "PASS [status quote]"

if [ "$FAILED" -eq 0 ]; then
	echo "RESULT: PASS"
	exit 0
fi
echo "RESULT: FAIL"
exit 1
