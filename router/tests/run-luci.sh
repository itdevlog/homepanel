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

# LuCI 25.x разворачивает depends.acl через spread: `push(ctx.acls,
# ...node.depends.acl)`. Поэтому здесь обязателен МАССИВ имён ACL; объект
# вида {"luci-app-homepanel": ["read","write"]} роняет диспетчер с
# "is not iterable". Заодно проверяем, что имя ACL определено в acl.d.
menu_acl_array() {
	python3 -c '
import json, sys
menu = json.load(open(sys.argv[1]))
acl = json.load(open(sys.argv[2]))
dep = menu["admin/services/homepanel"].get("depends", {}).get("acl")
assert isinstance(dep, list) and dep, "depends.acl must be a non-empty array, got %r" % (dep,)
for name in dep:
    assert isinstance(name, str), name
    assert name in acl, "ACL %r is not defined in acl.d" % name
    assert "read" in acl[name], "ACL %r has no read section" % name
' "$MENU" "$ACL" 2>/dev/null
}
run_check "menu.d depends.acl is array" menu_acl_array

run_check "acl.d exists" test -f "$ACL"
run_check "acl.d valid json" json_ok "$ACL"
run_check "acl.d ubus access" grep -q '"ubus"' "$ACL"
run_check "acl.d uci access" grep -q '"homepanel"' "$ACL"

run_check "overview.js exists" test -f "$VIEW"
run_check "overview.js form.Map" grep -q 'form.Map(' "$VIEW"
run_check "overview.js status rpc" grep -q "rpc.declare({ object: 'homepanel', method: 'status'" "$VIEW"
run_check "overview.js send rpc" grep -q "rpc.declare({ object: 'homepanel', method: 'send'" "$VIEW"
run_check "overview.js wired flag" grep -q "form.Flag, 'wired'" "$VIEW"
run_check "overview.js control flag" grep -q "form.Flag, 'control'" "$VIEW"
run_check "overview.js events flag" grep -q "form.Flag, 'events'" "$VIEW"
run_check "overview.js watcher row" grep -q 'Наблюдатель событий' "$VIEW"
run_check "overview.js nft row" grep -q 'nftables' "$VIEW"
run_check "overview.js control error row" grep -q 'Последняя ошибка управления' "$VIEW"

CONFIG="$FILES_DIR/etc/config/homepanel"
AGENT="$FILES_DIR/usr/share/ucode/homepanel/agent.uc"
run_check "config interval 20" grep -q "option interval '20'" "$CONFIG"
run_check "config wired flag" grep -q "option wired '1'" "$CONFIG"
run_check "config control flag" grep -q "option control '1'" "$CONFIG"
run_check "config events flag" grep -q "option events '1'" "$CONFIG"
run_check "agent status watcher" grep -q "watcher:" "$AGENT"
run_check "agent status nft" grep -q "nft:" "$AGENT"
run_check "agent status control error" grep -q "last_control_error:" "$AGENT"

if [ "$FAILED" -eq 0 ]; then
	echo "RESULT: PASS"
	exit 0
fi
echo "RESULT: FAIL"
exit 1
