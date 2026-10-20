# Home Panel

Домашняя панель: **кто дома** — по подключённым к WiFi клиентам роутера OpenWrt,
с историей присутствия и статистикой.

## Состав

- `server/` — сервер на Python 3 (только стандартная библиотека) + SQLite и
  ванильная веб-панель (без сборки).
- `router/` — агент для роутера OpenWrt (ucode + procd) и страница настроек
  LuCI; см. `docs/superpowers/plans/2026-10-18-homepanel-router.md`.
- `docs/superpowers/` — спецификация и планы реализации.

Архитектура: агент на роутере периодически снимает список ассоциированных
WiFi-клиентов и отправляет снимок на сервер (`POST /api/ingest`); сервер хранит
устройства, события и агрегаты, а панель показывает состояние и историю.

## Требования

- Python 3.11+ (только стандартная библиотека, внешних зависимостей нет).
- Любая ОС для разработки; для эксплуатации — Debian.

## Установка сервера

1. Скопировать репозиторий на сервер.
2. Создать конфигурацию из примера и задать секрет:

   ```bash
   install -Dm600 server/config.json.example /etc/homepanel/config.json
   "$EDITOR" /etc/homepanel/config.json
   ```

   Поля `config.json`:

   | Поле | Назначение | По умолчанию |
   |---|---|---|
   | `host` | адрес прослушивания (`127.0.0.1` — только за прокси; LAN-адрес или `0.0.0.0` — для прямых запросов агента) | `127.0.0.1` |
   | `port` | порт | `8787` |
   | `secret` | общий секрет с агентом (`X-Homepanel-Key`) | `CHANGE_ME` |
   | `graceSeconds` | окно дребезга присутствия, с | `300` |
   | `retention.minuteDays` | срок хранения минутных данных, дней | `30` |
   | `retention.dailyDays` | срок хранения дневных данных, дней | `365` |
   | `publicUrl` | публичный адрес панели | `""` |
   | `dbPath` | путь к файлу SQLite | `data/homepanel.sqlite3` |
   | `staticDir` | каталог статики панели | `<пакет>/../static` |

3. Запустить:

   ```bash
   python3 server/server.py --config /etc/homepanel/config.json
   ```

### systemd

Юнит — `server/systemd/homepanel.service` (ожидает пользователя `homepanel` и
репозиторий в `/home/homepanel/homepanel`; пути и `User=` при необходимости
поправить).

```bash
sudo install -Dm644 server/systemd/homepanel.service /etc/systemd/system/homepanel.service
sudo systemctl daemon-reload
sudo systemctl enable --now homepanel
```

### За Nginx Proxy Manager

Панель и API рассчитаны на работу за обратным прокси с TLS:

- прокси-хост → `http://127.0.0.1:8787`;
- включить SSL (Let's Encrypt);
- внешний доступ ограничивать на стороне NPM (allowlist/фаервол) —
  приложение авторизации не имеет и рассчитано на локальную сеть;
- открывать панель по HTTPS-домену (не по `IP:порт`), иначе браузерные
  уведомления не работают.

`/api/ingest` должен быть доступен агенту роутера. Два варианта:

- **Через NPM (рекомендуется).** В настройках агента `server_url` =
  публичный HTTPS-адрес панели (`https://homepanel.example.com/api/ingest`),
  а `host` сервера остаётся `127.0.0.1`. На стороне NPM разрешите доступ к
  `/api/ingest` с IP роутера.
- **Напрямую по локальной сети.** `server_url` =
  `http://<LAN-IP-сервера>:8787/api/ingest`, а `host` сервера выставьте в
  LAN-адрес (например `192.168.1.10`) или `0.0.0.0`. Порт `8787` при этом
  должен быть доступен только из локальной сети.

При `host = 127.0.0.1` и `server_url` с прямым `IP:8787` агент получит
`connection refused`.

## Роутер (OpenWrt)

Агент `homepanel-agent` (ucode + procd) периодически снимает список клиентов
со всех точек доступа (`ubus call hostapd.* get_clients`), обогащает его
арен­дами DHCP и отправляет снимок на сервер. Настройки и статус — в LuCI на
странице *Services → Home Panel*.

### Установка

Одной командой (на роутере, от root):

```sh
wget -O /tmp/hp.sh \
  https://raw.githubusercontent.com/itdevlog/homepanel/main/router/bootstrap.sh \
  && sh /tmp/hp.sh
```

Загрузчик проверяет окружение (OpenWrt, DNS, место в `/overlay`, наличие
`wget`/`uclient-fetch`), скачивает архив репозитория, при необходимости
доставляет недостающие ucode-модули (`ucode-mod-fs`, `-uci`, `-ubus`,
`-uloop`) и запускает `router/install.sh`. Повторный запуск — это обновление:
`/etc/config/homepanel` сохраняется. Флаги: `--ref REF` (ветка/тег),
`--dry-run`, `--dest DIR`, `--no-deps`, `--archive PATH`.

> В busybox ash нет process substitution, поэтому форма
> `sh <(wget -O - URL)` из инструкций podkop на OpenWrt не работает.
> Используйте команду выше либо `wget -qO- URL | sh`.

#### Вручную

1. Скопировать каталог `router/` на роутер:

   ```bash
   scp -r router root@192.168.1.1:/tmp/
   ```

2. Запустить установщик:

   ```bash
   ssh root@192.168.1.1 'sh /tmp/router/install.sh'
   ```

   Установщик раскладывает файлы из `router/files/` в `/`, выставляет права,
   включает и запускает сервис и сбрасывает кэш LuCI. Существующий
   `/etc/config/homepanel` при этом сохраняется — повторная установка не
   затирает `server_url` и `secret`. Флаг `--dry-run` раскладывает файлы, но
   не включает и не запускает сервис (нужен для тестов и ручной выкладки),
   `--dest DIR` меняет корень установки.

3. В LuCI *Services → Home Panel* заполнить:
   - `server_url` — адрес `POST /api/ingest` (см. раздел выше);
   - `secret` — тот же секрет, что в `config.json` сервера;
   - `interval` — период опроса, с (по умолчанию 30).

   Блок «Статус агента» показывает время последней отправки, число клиентов
   в снимке и текст последней ошибки; кнопка «Отправить сейчас» отправляет
   снимок немедленно.

4. Проверка из SSH: `ubus call homepanel status`, `ubus call homepanel send`.

### Персистентность

При обновлении прошивки (`sysupgrade`) разделы `/usr`, `/www` и
добавленный вручную init-скрипт не сохраняются. Поэтому установщик:

- кладёт копию всех файлов в `/etc/homepanel/` (`/etc` переживает
  `sysupgrade`);
- регистрирует сохраняемые пути в `/lib/upgrade/keep.d/homepanel`
  (`/etc/config/homepanel`, `/etc/homepanel`, `/etc/init.d/homepanel-agent`).

Переустановка после `sysupgrade`:

```bash
ssh root@192.168.1.1 'sh /etc/homepanel/install.sh'
```

Пользовательский конфиг при этом не перезаписывается, поэтому донастройка в
LuCI не требуется.

### Ручной чек-лист

- [ ] Сервис запущен: `/etc/init.d/homepanel-agent status`.
- [ ] В LuCI на странице *Home Panel* статус «Настроен», ошибок нет.
- [ ] «Отправить сейчас» завершается успешно, время последней отправки
      обновляется.
- [ ] На сервере (`/api/state`) появляются устройства роутера.
- [ ] После `reboot` роутера агент стартует автоматически.

## Безопасность

- Секрет `X-Homepanel-Key` защищает приём снимков; без него запросы к
  `/api/ingest` отклоняются с `401`.
- Панель аутентификации не имеет: не выставляйте её в интернет без
  ограничения доступа на стороне прокси/фаервола.

## Тесты

```bash
python3 -m unittest discover -s server/tests -t server   # сервер
node --test server/tests/js/                             # панель (чистая логика)
sh router/tests/run.sh          # агент: сбор снимка
sh router/tests/run-send.sh     # агент: отправка на сервер
sh router/tests/run-ubus.sh     # агент: ubus-объект (полностью — на роутере)
sh router/tests/run-luci.sh     # приложение LuCI (структура и JSON)
sh router/tests/run-install.sh  # установщик
sh router/tests/run-bootstrap.sh # загрузчик (локальный архив, без сети)
```

Тесты роутерной части требуют `ucode` (есть на OpenWrt; сборка из
`https://github.com/jow-/ucode`). Полная проверка ubus-объекта и страницы
LuCI выполняется на самом роутере.
