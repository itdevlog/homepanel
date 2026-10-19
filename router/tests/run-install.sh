#!/bin/sh
# Проверка установщика router/install.sh (Task 5).
#
# Запускает установщик в режиме --dry-run с указанным целевым корнем и
# сверяет раскладку файлов, права и персистентную копию.

set -u

TESTS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$TESTS_DIR/.." && pwd)
INSTALL="$ROOT_DIR/install.sh"
FAILED=0

echo "== install =="

DEST=$(mktemp -d)
LOG_FILE=$(mktemp)
trap 'rm -rf "$DEST"; rm -f "$LOG_FILE"' EXIT

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

if [ ! -f "$INSTALL" ]; then
	echo "FAIL: install.sh not found: $INSTALL"
	exit 1
fi

sh "$INSTALL" --dry-run --dest "$DEST" >"$LOG_FILE" 2>&1
RC=$?
if [ "$RC" -ne 0 ]; then
	echo "--- install.sh output ---"
	cat "$LOG_FILE"
	echo "-------------------------"
fi
run_check "install exit 0" test "$RC" -eq 0

for path in \
	etc/init.d/homepanel-agent \
	etc/config/homepanel \
	usr/share/ucode/homepanel/agent.uc \
	usr/share/luci/menu.d/luci-app-homepanel.json \
	usr/share/rpcd/acl.d/luci-app-homepanel.json \
	www/luci-static/resources/view/homepanel/overview.js ; do
	run_check "installed $path" test -f "$DEST/$path"
done

run_check "init script executable" test -x "$DEST/etc/init.d/homepanel-agent"
run_check "agent.uc executable" test -x "$DEST/usr/share/ucode/homepanel/agent.uc"

run_check "persist install.sh" test -f "$DEST/etc/homepanel/install.sh"
run_check "persist agent.uc" \
	test -f "$DEST/etc/homepanel/files/usr/share/ucode/homepanel/agent.uc"
run_check "persist overview.js" \
	test -f "$DEST/etc/homepanel/files/www/luci-static/resources/view/homepanel/overview.js"

if [ "$FAILED" -eq 0 ]; then
	echo "RESULT: PASS"
	exit 0
fi
echo "RESULT: FAIL"
exit 1
