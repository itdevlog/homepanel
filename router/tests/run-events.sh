#!/bin/sh
# Проверка watcher'а событий hostapd (Task 10).
#
# Режим --replay читает JSON-строки из файла; строка {"sleep": N} сдвигает
# виртуальное время на N мс (нужно для детерминированной проверки debounce и
# rate-limit без реальных задержек).

set -u

TESTS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$TESTS_DIR/.." && pwd)
EVENTS_UC="$ROOT_DIR/files/usr/share/ucode/homepanel/events.uc"
UCODE=${UCODE:-ucode}
FAILED=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

COUNTER="$TMP/count"
FAKE_AGENT="$TMP/agent"
export COUNTER

cat >"$FAKE_AGENT" <<'EOF'
#!/bin/sh
echo tick >> "$COUNTER"
EOF
chmod 0755 "$FAKE_AGENT"

run_check() {
	name="$1"
	shift
	if "$@"; then
		echo "PASS [$name]"
	else
		echo "FAIL [$name]"
		FAILED=1
	fi
}

run_case() {
	name="$1"
	fixture="$2"
	expected="$3"
	: >"$COUNTER"
	"$UCODE" "$EVENTS_UC" --replay "$fixture" --agent "$FAKE_AGENT"
	sleep 1
	count=$(wc -l <"$COUNTER" | tr -d ' ')
	run_check "$name ($count, ожидалось $expected)" test "$count" -eq "$expected"
}

if [ ! -f "$EVENTS_UC" ]; then
	echo "FAIL: events.uc not found: $EVENTS_UC"
	exit 1
fi

cat >"$TMP/basic.jsonl" <<'EOF'
{"type":"sta_connect","mac":"aa:bb:cc:dd:ee:01"}
{"type":"some_other_event"}
{"sleep":5000}
{"type":"sta_disconnect","mac":"aa:bb:cc:dd:ee:01"}
EOF

cat >"$TMP/debounce.jsonl" <<'EOF'
{"type":"sta_connect","mac":"aa:bb:cc:dd:ee:02"}
{"sleep":300}
{"type":"sta_connect","mac":"aa:bb:cc:dd:ee:02"}
EOF

cat >"$TMP/rate.jsonl" <<'EOF'
{"type":"sta_connect","mac":"aa:bb:cc:dd:ee:03"}
{"sleep":100}
{"type":"sta_connect","mac":"aa:bb:cc:dd:ee:03"}
{"sleep":300}
{"type":"sta_disconnect","mac":"aa:bb:cc:dd:ee:03"}
{"sleep":300}
{"type":"sta_connect","mac":"aa:bb:cc:dd:ee:03"}
EOF

run_case "connect + disconnect" "$TMP/basic.jsonl" 2
run_case "debounce 300 ms" "$TMP/debounce.jsonl" 1

# Четыре быстрых события: rate-limit 3 с не даёт больше двух триггеров.
: >"$COUNTER"
"$UCODE" "$EVENTS_UC" --replay "$TMP/rate.jsonl" --agent "$FAKE_AGENT"
sleep 1
RATE_COUNT=$(wc -l <"$COUNTER" | tr -d ' ')
run_check "rate limit ($RATE_COUNT, ожидалось <= 2)" test "$RATE_COUNT" -le 2
run_check "rate limit хотя бы один" test "$RATE_COUNT" -ge 1

if [ "$FAILED" -eq 0 ]; then
	echo "RESULT: PASS"
	exit 0
fi
echo "RESULT: FAIL"
exit 1
