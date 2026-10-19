#!/bin/sh
# Проверка приложения LuCI (Task 4): раскладка menu.d / acl.d и вид overview.js.
set -u

TESTS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$TESTS_DIR/.." && pwd)
FILES_DIR="$ROOT_DIR/files"
MENU="$FILES_DIR/usr/share/luci/menu.d/luci-app-homepanel.json"
ACL="$FILES_DIR/usr/share/rpcd/acl.d/luci-app-homepanel.json"
VIEW="$FILES_DIR/www/luci-static/resources/view/homepanel/overview.js"
FAILED=0

echo "== luci app =="

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

json_ok() {
	python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null
}

run_check "menu.d exists" test -f "$MENU"
run_check "menu.d valid json" json_ok "$MENU"
run_check "menu.d entry" grep -q '"admin/services/homepanel"' "$MENU"
run_check "menu.d view path" grep -q '"path": "homepanel/overview"' "$MENU"

run_check "acl.d exists" test -f "$ACL"
run_check "acl.d valid json" json_ok "$ACL"
run_check "acl.d ubus access" grep -q '"ubus"' "$ACL"
run_check "acl.d uci access" grep -q '"homepanel"' "$ACL"

run_check "overview.js exists" test -f "$VIEW"
run_check "overview.js form.Map" grep -q 'form.Map(' "$VIEW"
run_check "overview.js status rpc" grep -q "rpc.declare({ object: 'homepanel', method: 'status'" "$VIEW"
run_check "overview.js send rpc" grep -q "rpc.declare({ object: 'homepanel', method: 'send'" "$VIEW"

if [ "$FAILED" -eq 0 ]; then
	echo "RESULT: PASS"
	exit 0
fi
echo "RESULT: FAIL"
exit 1
