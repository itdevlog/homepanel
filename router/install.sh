#!/bin/sh
# Установщик агента Home Panel на роутер OpenWrt.
#
# Раскладывает содержимое router/files/ в корень системы (по умолчанию /),
# сохраняет персистентную копию в /etc/homepanel/ (каталог /etc переживает
# sysupgrade, тогда как /usr и /www — нет), включает и запускает сервис.
#
# Использование:
#   ./install.sh [--dry-run] [--dest DIR]
#
#   --dry-run   только разложить файлы, не включать сервис и не чистить кэш
#   --dest DIR  целевой корень (по умолчанию /; для тестов — временный каталог)

set -u

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC_DIR="$SELF_DIR/files"
PERSIST_NAME="homepanel"

DEST="/"
DRY_RUN=0

usage() {
	cat >&2 <<EOF
Использование: $0 [--dry-run] [--dest DIR]
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run)
			DRY_RUN=1
			;;
		--dest)
			shift
			if [ $# -eq 0 ]; then
				echo "install: --dest требует аргумент" >&2
				exit 2
			fi
			DEST="$1"
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			echo "install: неизвестный аргумент: $1" >&2
			usage
			exit 2
			;;
	esac
	shift
done

if [ ! -d "$SRC_DIR" ]; then
	echo "install: не найден каталог с файлами: $SRC_DIR" >&2
	exit 1
fi

DEST=${DEST%/}
[ -n "$DEST" ] || DEST="/"

echo "install: копирование $SRC_DIR -> $DEST"
mkdir -p "$DEST"
cp -r "$SRC_DIR/." "$DEST/"

# Права на исполняемые файлы.
chmod 0755 "$DEST/etc/init.d/homepanel-agent"
chmod 0755 "$DEST/usr/share/ucode/homepanel/agent.uc"

# Персистентная копия для переустановки после sysupgrade.
PERSIST="$DEST/etc/$PERSIST_NAME"
echo "install: персистентная копия -> $PERSIST"
mkdir -p "$PERSIST/files"
cp "$SELF_DIR/install.sh" "$PERSIST/install.sh"
cp -r "$SRC_DIR/." "$PERSIST/files/"

if [ "$DRY_RUN" -eq 0 ] && [ "$DEST" = "/" ]; then
	echo "install: включение сервиса"
	/etc/init.d/homepanel-agent enable
	/etc/init.d/homepanel-agent start

	reload_config 2>/dev/null || true
	/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart 2>/dev/null || true

	# Сброс кэша LuCI, чтобы появилось новое меню.
	rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
	echo "install: готово"
else
	echo "install: файлы разложены (сервис не запускался)"
fi
