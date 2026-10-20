#!/bin/sh
# Проверка bootstrap-загрузчика router/bootstrap.sh.
#
# Собирает tarball в формате GitHub (единственный верхний каталог
# homepanel-main/router/...), запускает загрузчик с --archive (без сети) и
# --dest (без записи в /), проверяет раскладку, повторную установку и
# обработку ошибок.
#
# Требует: sh, tar, gzip. Выполняется локально.

set -u

TESTS_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$TESTS_DIR/.." && pwd)
BOOTSTRAP="$ROOT_DIR/bootstrap.sh"
FAILED=0

fail() {
	echo "FAIL: $*"
	FAILED=1
}

check() {
	name="$1"
	shift
	if "$@"; then
		echo "PASS [$name]"
	else
		echo "FAIL [$name]"
		FAILED=1
	fi
}

if [ ! -f "$BOOTSTRAP" ]; then
	echo "FAIL: bootstrap not found: $BOOTSTRAP"
	exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Архив как у GitHub: один верхний каталог homepanel-main/.
mkdir -p "$WORK/pkg/homepanel-main"
cp -R "$ROOT_DIR" "$WORK/pkg/homepanel-main/router"
tar -czf "$WORK/homepanel-main.tar.gz" -C "$WORK/pkg" homepanel-main

# Архив без router/install.sh (для проверки внятной ошибки).
mkdir -p "$WORK/empty-repo/other"
echo x > "$WORK/empty-repo/other/file"
tar -czf "$WORK/empty.tar.gz" -C "$WORK/empty-repo" other

# --- 1: --help -----------------------------------------------------------
OUT=$(sh "$BOOTSTRAP" --help 2>&1)
RC=$?
check "help exit 0" test "$RC" -eq 0
echo "$OUT" | grep -q "Использование" \
	&& echo "PASS [help usage]" || fail "help: нет строки «Использование»"

# --- 2: неизвестный флаг -------------------------------------------------
sh "$BOOTSTRAP" --nope >/dev/null 2>&1
RC=$?
check "unknown flag exit 2" test "$RC" -eq 2

# --- 3: установка из локального архива -----------------------------------
DEST="$WORK/dest"
sh "$BOOTSTRAP" --archive "$WORK/homepanel-main.tar.gz" --dry-run \
	--dest "$DEST" --no-deps >"$WORK/out3" 2>&1
RC=$?
if [ "$RC" -ne 0 ]; then
	echo "--- bootstrap output ---"
	cat "$WORK/out3"
	echo "------------------------"
fi
check "install exit 0" test "$RC" -eq 0

for path in \
	etc/init.d/homepanel-agent \
	etc/config/homepanel \
	etc/homepanel/install.sh \
	lib/upgrade/keep.d/homepanel \
	usr/share/ucode/homepanel/agent.uc \
	usr/share/luci/menu.d/luci-app-homepanel.json \
	usr/share/rpcd/acl.d/luci-app-homepanel.json \
	www/luci-static/resources/view/homepanel/overview.js ; do
	check "installed $path" test -f "$DEST/$path"
done
check "agent executable" test -x "$DEST/usr/share/ucode/homepanel/agent.uc"

# --- 4: повторная установка сохраняет конфиг -----------------------------
printf 'config homepanel "main"\n\toption secret "kept"\n' \
	> "$DEST/etc/config/homepanel"
sh "$BOOTSTRAP" --archive "$WORK/homepanel-main.tar.gz" --dry-run \
	--dest "$DEST" --no-deps >"$WORK/out4" 2>&1
RC=$?
check "reinstall exit 0" test "$RC" -eq 0
check "reinstall keeps config" grep -q '"kept"' "$DEST/etc/config/homepanel"

# --- 5: отсутствующий архив ----------------------------------------------
DEST2="$WORK/dest2"
sh "$BOOTSTRAP" --archive "$WORK/does-not-exist.tar.gz" --dry-run \
	--dest "$DEST2" --no-deps >"$WORK/out5" 2>&1
RC=$?
check "missing archive fails" test "$RC" -ne 0
check "missing archive installs nothing" \
	test ! -f "$DEST2/etc/init.d/homepanel-agent"

# --- 6: архив без install.sh ---------------------------------------------
sh "$BOOTSTRAP" --archive "$WORK/empty.tar.gz" --dry-run \
	--dest "$WORK/dest3" --no-deps >"$WORK/out6" 2>&1
RC=$?
check "archive without installer fails" test "$RC" -ne 0
grep -q "router/install.sh" "$WORK/out6" \
	&& echo "PASS [error mentions install.sh]" \
	|| fail "нет внятной ошибки про router/install.sh"

if [ "$FAILED" -eq 0 ]; then
	echo "RESULT: PASS"
	exit 0
fi
echo "RESULT: FAIL"
exit 1
