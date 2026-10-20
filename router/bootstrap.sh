#!/bin/sh
# Загрузчик установщика Home Panel для роутера OpenWrt.
#
# Скачивает архив репозитория с GitHub, распаковывает во временный каталог и
# запускает router/install.sh. Установка сводится к одной команде:
#
#   wget -O /tmp/hp.sh \
#     https://raw.githubusercontent.com/itdevlog/homepanel/main/router/bootstrap.sh \
#     && sh /tmp/hp.sh
#
# Форма `sh <(wget -O - URL)` из примеров podkop на OpenWrt НЕ работает: в
# busybox ash нет process substitution. Рабочие варианты — сохранить файл
# (как выше) или `wget -qO- URL | sh` (скрипт не читает stdin).
#
# Флаги:
#   --ref REF       ветка или тег (по умолчанию main)
#   --archive PATH  локальный tar.gz вместо скачивания (тесты/офлайн)
#   --dest DIR      корень установки (по умолчанию /)
#   --dry-run       разложить файлы, не включая и не запуская сервис
#   --no-deps       не проверять и не доставлять ucode-модули
#   --help

set -u

REPO="itdevlog/homepanel"
DEFAULT_REF="main"
RETRIES=3
REQUIRED_KB=5120

REF="$DEFAULT_REF"
ARCHIVE=""
DEST=""
DRY_RUN=0
CHECK_DEPS=1

msg()  { printf '\033[32;1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33;1m%s\033[0m\n' "$*" >&2; }
err()  { printf '\033[31;1m%s\033[0m\n' "$*" >&2; }

usage() {
	cat <<EOF
Использование: sh bootstrap.sh [--ref REF] [--archive PATH] [--dest DIR]
                [--dry-run] [--no-deps]

  --ref REF       ветка или тег репозитория $REPO (по умолчанию $DEFAULT_REF)
  --archive PATH  локальный tar.gz вместо скачивания с GitHub
  --dest DIR      корень установки (по умолчанию /)
  --dry-run       разложить файлы, но не включать и не запускать сервис
  --no-deps       не проверять и не доставлять ucode-модули
  --help, -h      эта справка
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--ref|--archive|--dest)
			opt="$1"
			shift
			if [ $# -eq 0 ]; then
				err "$opt требует аргумент"
				exit 2
			fi
			case "$opt" in
				--ref) REF="$1" ;;
				--archive) ARCHIVE="$1" ;;
				--dest) DEST="$1" ;;
			esac
			;;
		--dry-run) DRY_RUN=1 ;;
		--no-deps) CHECK_DEPS=0 ;;
		--help|-h) usage; exit 0 ;;
		*)
			err "неизвестный аргумент: $1"
			usage >&2
			exit 2
			;;
	esac
	shift
done

if [ -z "$REF" ]; then
	err "--ref не может быть пустым"
	exit 2
fi

# Пустой DEST означает установку в / — там нужен root. С --dest (тесты,
# сборка образа) root не требуется: пишем в указанный каталог.
DEST=${DEST%/}
if [ -z "$DEST" ] && [ "$(id -u)" -ne 0 ]; then
	err "нужен root (либо укажите --dest DIR)"
	exit 1
fi

if [ -z "$DEST" ]; then
	if [ ! -f /etc/openwrt_release ]; then
		err "не похоже на OpenWrt: нет /etc/openwrt_release"
		exit 1
	fi
	if [ -d /overlay ]; then
		AVAIL=$(df /overlay | awk 'NR==2 {print $4}')
		if [ "${AVAIL:-0}" -lt "$REQUIRED_KB" ]; then
			err "мало места в /overlay: ${AVAIL:-0} КБ, нужно $REQUIRED_KB КБ"
			exit 1
		fi
	fi
fi

for tool in gzip tar; do
	command -v "$tool" >/dev/null 2>&1 || { err "не найдено: $tool"; exit 1; }
done

if [ -z "$ARCHIVE" ]; then
	if ! command -v wget >/dev/null 2>&1 && ! command -v uclient-fetch >/dev/null 2>&1; then
		err "нужен wget или uclient-fetch"
		exit 1
	fi
	# DNS проверяем только там, где он вообще есть (в тестах не нужен).
	if command -v nslookup >/dev/null 2>&1; then
		nslookup github.com >/dev/null 2>&1 || { err "DNS не работает"; exit 1; }
	fi
fi

fetch() { # $1 = url, $2 = файл назначения
	if command -v wget >/dev/null 2>&1 &&
	   wget -q -T 20 -O "$2" "$1" && [ -s "$2" ]; then
		return 0
	fi
	if command -v uclient-fetch >/dev/null 2>&1 &&
	   uclient-fetch -q -T 20 -O "$2" "$1" && [ -s "$2" ]; then
		return 0
	fi
	return 1
}

# Модули, без которых агент теряет функциональность: fs нужен всегда, uci —
# для конфига, ubus/uloop — для объекта в шине (его читает LuCI).
ensure_deps() {
	command -v ucode >/dev/null 2>&1 || return 0
	missing=""
	for m in fs uci ubus uloop; do
		if ! ucode -e "try { require('$m') } catch (e) { exit(1) }" >/dev/null 2>&1; then
			missing="$missing ucode-mod-$m"
		fi
	done
	[ -n "$missing" ] || return 0

	msg "Не хватает ucode-модулей:$missing"
	if command -v apk >/dev/null 2>&1; then
		apk update >/dev/null 2>&1 || warn "apk update не удался"
		# shellcheck disable=SC2086
		apk add $missing && INSTALLED=1
	elif command -v opkg >/dev/null 2>&1; then
		opkg update >/dev/null 2>&1 || warn "opkg update не удался"
		# shellcheck disable=SC2086
		opkg install $missing && INSTALLED=1
	fi

	still=""
	for m in fs uci ubus uloop; do
		if ! ucode -e "try { require('$m') } catch (e) { exit(1) }" >/dev/null 2>&1; then
			still="$still $m"
		fi
	done
	if [ -n "$still" ]; then
		warn "модули всё ещё недоступны:$still — агент запустится, но ubus-методы"
		warn "и статус в LuCI могут не работать. Поставьте их вручную (apk add ...)."
	fi
}

WORK=$(mktemp -d /tmp/homepanel-install.XXXXXX) ||
	{ err "не удалось создать временный каталог"; exit 1; }
KEEP_WORK=0
cleanup() {
	if [ "$KEEP_WORK" -eq 0 ]; then
		rm -rf "$WORK"
	fi
}
trap cleanup EXIT

if [ -n "$ARCHIVE" ]; then
	msg "Локальный архив: $ARCHIVE"
	cp "$ARCHIVE" "$WORK/src.tar.gz" || {
		KEEP_WORK=1
		err "не удалось прочитать архив: $ARCHIVE"
		exit 1
	}
else
	URL="https://github.com/$REPO/archive/$REF.tar.gz"
	msg "Скачивание $URL"
	n=0
	while [ "$n" -lt "$RETRIES" ]; do
		n=$((n + 1))
		if fetch "$URL" "$WORK/src.tar.gz"; then
			break
		fi
		warn "попытка $n из $RETRIES не удалась"
		rm -f "$WORK/src.tar.gz"
		sleep 2
	done
	if [ ! -s "$WORK/src.tar.gz" ]; then
		KEEP_WORK=1
		err "не удалось скачать $URL"
		exit 1
	fi
fi

msg "Распаковка"
if ! gzip -dc "$WORK/src.tar.gz" | tar -x -C "$WORK"; then
	KEEP_WORK=1
	err "не удалось распаковать архив"
	exit 1
fi

SRC=""
for d in "$WORK"/*/; do
	if [ -f "${d}router/install.sh" ]; then
		SRC="${d%/}"
		break
	fi
done
if [ -z "$SRC" ]; then
	KEEP_WORK=1
	err "в архиве нет router/install.sh"
	exit 1
fi

if [ "$CHECK_DEPS" -eq 1 ] && [ -z "$DEST" ]; then
	ensure_deps
fi

msg "Запуск установщика"
set --
if [ "$DRY_RUN" -eq 1 ]; then
	set -- "$@" --dry-run
fi
if [ -n "$DEST" ]; then
	set -- "$@" --dest "$DEST"
fi

sh "$SRC/router/install.sh" "$@"
RC=$?

if [ "$RC" -eq 0 ]; then
	msg "Готово"
	cat <<EOF

Дальше:
  1. LuCI → Services → Home Panel
  2. Укажите server_url (POST /api/ingest) и secret
  3. Проверка: ubus call homepanel status && ubus call homepanel send

EOF
else
	KEEP_WORK=1
	err "установщик завершился с кодом $RC; распакованные файлы: $SRC"
fi

exit "$RC"
