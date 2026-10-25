#!/bin/sh
# Проверка сбора снимка агентом Home Panel (план роутера, Task 1).
#
# Требуется только `ucode` — скрипт работает и на машине разработки,
# и на самом роутере. Путь к агенту можно переопределить HOMEPANEL_AGENT.

set -u

TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
FIX="$TESTS_DIR/fixtures"
FIX_CONNECTED="$TESTS_DIR/fixtures-connected"
AGENT=${HOMEPANEL_AGENT:-"$TESTS_DIR/../files/usr/share/ucode/homepanel/agent.uc"}
NOW=1760000300

if [ ! -f "$AGENT" ]; then
	echo "FAIL: agent not found: $AGENT"
	exit 1
fi

fail=0

run_case() {
	name=$1
	dir=$2
	leases=$3
	expected=$4
	out="$TESTS_DIR/.out-$name.json"
	err="$TESTS_DIR/.err-$name.txt"

	if ! ucode "$AGENT" --once --ubus-dir "$dir" --leases "$leases" --now "$NOW" \
			--loadavg "$FIX/loadavg.txt" \
			>"$out" 2>"$err"; then
		echo "FAIL [$name]: agent exited non-zero"
		sed 's/^/    /' "$err"
		fail=1
	elif ucode "$TESTS_DIR/check.uc" "$expected" "$out" >/dev/null 2>"$err"; then
		echo "PASS [$name]"
	else
		echo "FAIL [$name]: snapshot mismatch"
		sed 's/^/    /' "$err"
		fail=1
	fi

	rm -f "$out" "$err"
}

echo "== Task 1: agent collect =="
run_case "main"      "$FIX"            "$FIX/dhcp.leases"           "$TESTS_DIR/expected-snapshot.json"
run_case "no-leases" "$FIX"            "/nonexistent/dhcp.leases"   "$TESTS_DIR/expected-no-leases.json"
run_case "no-bss"    "/nonexistent/ubus" "$FIX/dhcp.leases"         "$TESTS_DIR/expected-empty.json"
run_case "connected" "$FIX_CONNECTED"  "$FIX_CONNECTED/dhcp.leases" "$TESTS_DIR/expected-connected.json"

if [ "$fail" -ne 0 ]; then
	echo "RESULT: FAIL"
	exit 1
fi

echo "RESULT: PASS"
