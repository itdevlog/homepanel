#!/bin/sh
# Проверка ubus-объекта homepanel (Task 3).
#
# Полная проверка требует ubus (роутер OpenWrt). На машине разработки модуля
# ubus нет, поэтому локально проверяется graceful degradation: агент с
# --ubus-object не падает и предупреждает об отсутствии модуля (Ruling R7).

set -u

TESTS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$TESTS_DIR/.." && pwd)
AGENT=${HOMEPANEL_AGENT:-$ROOT_DIR/files/usr/share/ucode/homepanel/agent.uc}
NOW=1760000300
FAILED=0

echo "== ubus object =="

if [ ! -f "$AGENT" ]; then
	echo "FAIL: agent not found: $AGENT"
	exit 1
fi

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

STATUS_FILE=$(mktemp)
OUT_FILE=$(mktemp)
ERR_FILE=$(mktemp)
trap 'rm -f "$STATUS_FILE" "$OUT_FILE" "$ERR_FILE"' EXIT

if command -v ubus >/dev/null 2>&1; then
	echo "[info] ubus найден: полная проверка"

	ucode "$AGENT" --ubus-object --status "$STATUS_FILE" \
		--ubus-dir "$TESTS_DIR/fixtures" \
		--leases "$TESTS_DIR/fixtures/dhcp.leases" \
		--now "$NOW" >/dev/null 2>"$ERR_FILE" &
	AGENT_PID=$!
	sleep 1

	ubus call homepanel status >"$OUT_FILE" 2>&1
	for field in version client_count configured enabled last_send last_error; do
		run_check "status.$field" grep -q "\"$field\"" "$OUT_FILE"
	done

	ubus call homepanel send >"$OUT_FILE" 2>&1
	run_check "send.ok" grep -q '"ok"' "$OUT_FILE"

	kill "$AGENT_PID" 2>/dev/null
	wait "$AGENT_PID" 2>/dev/null
else
	echo "[skip] ubus недоступен: проверяется только деградация"

	ucode "$AGENT" --ubus-object --send --status "$STATUS_FILE" \
		--ubus-dir "$TESTS_DIR/fixtures" \
		--leases "$TESTS_DIR/fixtures/dhcp.leases" \
		--now "$NOW" >/dev/null 2>"$ERR_FILE"
	RC=$?

	run_check "degraded exit 0" test "$RC" -eq 0
	run_check "degraded warns about ubus" grep -qi 'ubus' "$ERR_FILE"
fi

if [ "$FAILED" -eq 0 ]; then
	echo "RESULT: PASS"
	exit 0
fi
echo "RESULT: FAIL"
exit 1
