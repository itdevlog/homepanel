# Home Panel — Router Agent & LuCI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Агент на OpenWrt (ucode + procd), снимающий список WiFi-клиентов со всех BSS и отправляющий их на сервер, плюс страница настроек в LuCI со статусом и кнопкой «отправить сейчас».

**Architecture:** Один ucode-скрипт `agent.uc` с функцией `collect()` (чистая логика снимка) и `main()` (цикл/одиночный запуск/отправка). procd-инициализация; настройки в UCI; статус и ручная отправка — через ubus-объект `homepanel`, который регистрирует агент. LuCI-приложение ставится раскладкой файлов (без buildroot).

**Tech Stack:** ucode 0.1.x (модули `ubus`, `uci`, `uloop`, `fs`), procd, ubus, UCI, LuCI (JS-вид + `menu.d`/`acl.d`), busybox `wget`/`uclient-fetch`, шина OpenWrt 25.12 (пакеты — `apk`).

**Spec:** `docs/superpowers/specs/2026-10-18-homepanel-design.md`

## Global Constraints

- Целевая прошивка: OpenWrt 25.12.x, узел **Cudy WR3000S v1**; **uclibc**/musl без Python; интерпретатор — `ucode`.
- **Пакетный менеджер — `apk`** (не `opkg`).
- Никаких внешних зависимостей сверх базовой поставки (`ubus`, `uci`, `procd`, `ucode`, `uclient-fetch`).
- `ucode` **отсутствует на машине разработки** — все проверки в этом плане выполняются **на роутере** (или на машине с `ucode`). Это осознанное ограничение, отмечено в каждом шаге проверки.
- HTTP-отправка — только стандартными средствами: `uclient-fetch` (если доступен), иначе busybox `wget --post-file`.
- Секрет не пишется в логи; в `/tmp` файл снимка создаётся с правами `600`.
- UCI-конфиг: `/etc/config/homepanel`; персистентный каталог `/etc/homepanel/` (`/etc` переживает `sysupgrade`, `/usr` и `/www` — нет).
- Имена BSS берутся динамически через `ubus list 'hostapd.*'`, служебные объекты `hostapd` и `hostapd-auth` отбрасываются.
- Пользовательские строки интерфейса — по-русски; идентификаторы — по-английски.
- Коммиты — законченные, формат `feat(router): …`.

## Review Focus

Классы входных данных/состояний, которые спека подразумевает, но ни один тест задачи прямо не диктует. Для каждой — тест в задаче-владельце:

1. **Отсутствие объектов `hostapd.*`** (WiFi выключен, один radio отключён) — ожидание: снимок пустой, агент не падает и не зависает. (Task 1)
2. **Пропавший/пустой `/tmp/dhcp.leases`** — ожидание: `ip`/`hostname` пустые, снимок всё равно формируется. (Task 1)
3. **Сервер недоступен во время отправки** (`connection refused`/таймаут) — ожидание: агент пишет ошибку в syslog и продолжает цикл на следующем тике, не выходя. (Task 2)
4. **Секрет/URL не заданы в UCI** — ожидание: агент не отправляет, статус «не настроен», в лог — предупреждение. (Task 2)
5. **Некорректный JSON-ответ сервера/нестандартный код** — ожидание: агент не падает, трактует как ошибку, повторяет на следующем тике. (Task 2)

---

### Task 1: Агент — сбор снимка (`collect`) с офлайн-фикстурами

**Files:**
- Create: `router/files/usr/share/ucode/homepanel/agent.uc`
- Create: `router/tests/fixtures/dhcp.leases`
- Create: `router/tests/fixtures/get_clients_phy0-ap0.json`, `router/tests/fixtures/get_clients_phy1-ap0.json`
- Create: `router/tests/run.sh`
- Test: `router/tests/expected-snapshot.json`

**Interfaces:**
- Consumes: `ubus call hostapd.<bss> get_clients` → `{ "freq": int, "clients": { "<mac>": { … } } }`; `/tmp/dhcp.leases` (строки `<expiry> <mac> <ip> <hostname> <clientid>`).
- Produces (в `agent.uc`): `list_bss() -> array<string>`, `read_leases(path) -> object` (карта `mac → { ip, hostname }`), `collect(env) -> object` (снимок из спеки §5), `band_of(freq: int) -> string` (`"2.4"`/`"5"`). Переменная окружения `HOMEPANEL_UBUS_DIR` подменяет вызовы `ubus` чтением `<dir>/get_clients_<bss>.json`.

- [ ] **Step 1: Создать фикстуры и ожидаемый снимок**

`router/tests/fixtures/dhcp.leases`:
```
1760000300 aa:bb:cc:dd:ee:ff 192.168.1.42 iPhone-Ivan 01:aa:bb:cc:dd:ee:ff
1760000300 11:22:33:44:55:66 192.168.1.77 unnamed-device *
```
`router/tests/fixtures/get_clients_phy0-ap0.json`:
```json
{ "freq": 2412, "clients": { "aa:bb:cc:dd:ee:ff": { "signal": -52 } } }
```
`router/tests/fixtures/get_clients_phy1-ap0.json`:
```json
{ "freq": 5180, "clients": { "11:22:33:44:55:66": { "signal": -61 } } }
```
`router/tests/expected-snapshot.json`: массив клиентов, отсортированный по `mac`, с полями `mac, bss, band, signal, ip, hostname`.

- [ ] **Step 2: Написать проверочный скрипт (падающий)**

`router/tests/run.sh` — вызывает `ucode /usr/share/ucode/homepanel/agent.uc --once --ubus-dir router/tests/fixtures --leases router/tests/fixtures/dhcp.leases --now 1760000300`, печатает JSON; `jsonschema`-проверки нет — сравнение с `expected-snapshot.json` через `python3 -c` (или `jsonfilter`). Скрипт завершается ненулевым кодом, если `agent.uc` отсутствует.

- [ ] **Step 3: Запустить — убедиться, что падает**

Run (на роутере): `sh router/tests/run.sh`
Expected: FAIL (`agent.uc: not found` / пустой JSON)

- [ ] **Step 4: Реализовать `collect` и разбор аргументов в `agent.uc`**

Реализовать: `list_bss()` (`ubus list 'hostapd.*'` с фильтром или `ls` каталога фикстур в тест-режиме), `read_leases`, `band_of`, `collect(env)`: объединяет клиентов всех BSS по MAC (при дубле — сильнейший `signal`), обогащает `ip`/`hostname` из арен, `signal` → int, отсутствующие `hostapd.*` и отсутствующий файл арен — не ошибка (Review Focus 1 и 2). `--once` печатает снимок и выходит; `--ubus-dir`, `--leases`, `--now` — опциональные переопределения для тестов.

- [ ] **Step 5: Запустить — убедиться, что проходит**

Run (на роутере): `sh router/tests/run.sh`
Expected: PASS (JSON совпадает с `expected-snapshot.json`; при необходимости повтор с пустым каталогом фикстур → пустой массив клиентов)

- [ ] **Step 6: Коммит**

```bash
git add router/files/usr/share/ucode/homepanel/agent.uc router/tests
git commit -m "feat(router): agent snapshot collection with offline fixtures"
```

---

### Task 2: Агент — UCI, отправка и procd

**Files:**
- Create: `router/files/etc/config/homepanel`
- Create: `router/files/etc/init.d/homepanel-agent`
- Modify: `router/files/usr/share/ucode/homepanel/agent.uc`
- Test: `router/tests/run-send.sh`

**Interfaces:**
- Consumes: `collect` (Task 1), UCI `/etc/config/homepanel` (`homepanel.main`: `enabled`, `server_url`, `secret`, `interval`), заголовок `X-Homepanel-Key`.
- Produces: `read_config() -> object`, `send_snapshot(cfg, snapshot) -> object` (`{ ok: bool, code: int, error: string | null }`), `status_path()` → `/tmp/homepanel.status` (JSON со временем последней отправки, числом клиентов, версией, последней ошибкой). Цикл в `main()` с `uloop`/`sleep` по `interval`.

- [ ] **Step 1: Создать UCI-умолчания и procd-скрипт**

`router/files/etc/config/homepanel`:
```uci
config homepanel 'main'
    option enabled '1'
    option server_url ''
    option secret ''
    option interval '30'
```
`router/files/etc/init.d/homepanel-agent` — `USE_PROCD=1`, `START`, `procd_open_instance` / `procd_set_param command /usr/bin/ucode /usr/share/ucode/homepanel/agent.uc`, `procd_set_param respawn`, `stdout`/`stderr` → syslog.

- [ ] **Step 2: Написать проверку отправки (падающую)**

`router/tests/run-send.sh` — поднимает локальный `nc -l` (или `python3 -m http.server` при наличии) как фальшивый сервер, запускает `agent.uc --once --send --ubus-dir … --leases … --server-url http://127.0.0.1:<port>/api/ingest --secret test`, проверяет, что: (а) тело запроса — валидный JSON со `schema:1` и заголовком `X-Homepanel-Key`; (б) `/tmp/homepanel.status` создан. Дополнительно проверяются Review Focus 3–5: сервер выключен → `ok:false` и запись в status; пустой `server_url`/`secret` → отправки нет, статус «не настроен»; сервер вернул `500`/не-JSON → `ok:false`, процесс завершился с кодом 0.

- [ ] **Step 3: Запустить — убедиться, что падает**

Run (на роутере): `sh router/tests/run-send.sh`
Expected: FAIL (нет режима `--send`)

- [ ] **Step 4: Реализовать `read_config`, `send_snapshot`, `--send` и цикл**

`read_config` читает UCI через модуль `uci`. `send_snapshot` пишет тело во временный файл `600`, вызывает `uclient-fetch` (если есть) иначе busybox `wget --post-file`, с `--header 'Content-Type: application/json'` и `--header 'X-Homepanel-Key: <secret>'`; разбирает ответ и HTTP-код; не бросает исключений наружу. `main()`: при `enabled != 1` — лог и выход; при пустых `server_url`/`secret` — предупреждение и ожидание (без отправки). Цикл: `collect` → `send_snapshot` → запись `status_path()` → `sleep(interval)`. Ошибки — в syslog через `logger`.

- [ ] **Step 5: Запустить — убедиться, что проходит**

Run (на роутере): `sh router/tests/run-send.sh`
Expected: PASS (все ветви Review Focus 3–5 дают ожидаемый результат, код возврата 0)

- [ ] **Step 6: Коммит**

```bash
git add router/files/etc/config/homepanel router/files/etc/init.d/homepanel-agent router/files/usr/share/ucode/homepanel/agent.uc router/tests/run-send.sh
git commit -m "feat(router): UCI config, HTTP send and procd init"
```

---

### Task 3: ubus-объект `homepanel` (status / send)

**Files:**
- Modify: `router/files/usr/share/ucode/homepanel/agent.uc`
- Test: `router/tests/run-ubus.sh`

**Interfaces:**
- Consumes: `send_snapshot`, `status_path` (Task 2)
- Produces: ubus-объект `homepanel` с методами `status` → `{ configured: bool, enabled: bool, last_send: int, client_count: int, version: string, last_error: string | null }` и `send` → `{ ok: bool }` (инициирует немедленную отправку и возвращает результат). Флаг `--ubus-object` запускает регистрацию объекта.

- [ ] **Step 1: Написать проверку (падающую)**

`router/tests/run-ubus.sh` — запускает `agent.uc --ubus-object` в фоне, затем `ubus call homepanel status` и `ubus call homepanel send`, сверяет наличие полей и `ok`.

- [ ] **Step 2: Запустить — убедиться, что падает**

Run (на роутере): `sh router/tests/run-ubus.sh`
Expected: FAIL (`ubus call`: object not found)

- [ ] **Step 3: Реализовать регистрацию ubus-объекта**

Через модуль `ubus` (`ubus.publish`/`connection.subscribe`) методы читают `status_path()`; `send` вызывает `send_snapshot(collect(env), read_config())` и обновляет статус. Основной цикл агента работает параллельно (uloop).

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run (на роутере): `sh router/tests/run-ubus.sh`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add router/files/usr/share/ucode/homepanel/agent.uc router/tests/run-ubus.sh
git commit -m "feat(router): ubus object exposing status and send"
```

---

### Task 4: Приложение LuCI

**Files:**
- Create: `router/files/usr/share/luci/menu.d/luci-app-homepanel.json`
- Create: `router/files/usr/share/rpcd/acl.d/luci-app-homepanel.json`
- Create: `router/files/www/luci-static/resources/view/homepanel/overview.js`
- Test: `router/tests/run-luci.sh`

**Interfaces:**
- Consumes: ubus-объект `homepanel` (Task 3), UCI `/etc/config/homepanel` (Task 2)
- Produces: страница LuCI `admin/services/homepanel` — форма настроек (`form.Map`), блок статуса, кнопка «Отправить сейчас».

- [ ] **Step 1: Создать `menu.d` и `acl.d`**

`menu.d/luci-app-homepanel.json`:
```json
{ "admin/services/homepanel": {
    "title": "Home Panel", "order": 60,
    "action": { "type": "view", "path": "homepanel/overview" },
    "depends": { "acl": { "uci": { "homepanel": ["read", "write"] } } } } }
```
`acl.d/luci-app-homepanel.json`: `uci` read/write для `homepanel` и `ubus` доступ к объекту `homepanel`.

- [ ] **Step 2: Написать проверку (падающую)**

`router/tests/run-luci.sh` — валидирует оба JSON (`python3 -c "import json,sys; json.load(open(sys.argv[1]))"` или `jsonfilter`), проверяет, что `overview.js` содержит `rpc.declare({ object: 'homepanel', method: 'status' })` и `form.Map(section, 'homepanel')`; проверяет, что файлы лежат по путям `menu.d`/`acl.d`.

- [ ] **Step 3: Запустить — убедиться, что падает**

Run: `sh router/tests/run-luci.sh`
Expected: FAIL (файлы отсутствуют)

- [ ] **Step 4: Реализовать `overview.js`**

Форма `form.Map(section, 'homepanel')` с полями `enabled` (Flag), `server_url` (Value), `secret` (Value, `password`), `interval` (Value, integer). Блок статуса — `rpc.declare({ object: 'homepanel', method: 'status', expect: {} })`, периодическое обновление; кнопка «Отправить сейчас» → `rpc.declare({ object: 'homepanel', method: 'send' })`; вывод последней ошибки и времени последней отправки.

- [ ] **Step 5: Запустить — убедиться, что проходит**

Run: `sh router/tests/run-luci.sh`
Expected: PASS

- [ ] **Step 6: Коммит**

```bash
git add router/files/usr/share/luci/menu.d/luci-app-homepanel.json router/files/usr/share/rpcd/acl.d/luci-app-homepanel.json router/files/www/luci-static/resources/view/homepanel/overview.js router/tests/run-luci.sh
git commit -m "feat(router): LuCI configuration page"
```

---

### Task 5: Установка, персистентность и документация

**Files:**
- Create: `router/install.sh`
- Modify: `README.md`
- Test: `router/tests/run-install.sh`

**Interfaces:**
- Consumes: все файлы `router/files/**`
- Produces: `install.sh` (раскладывает файлы из `router/files/` в `/`, сохраняет копию в `/etc/homepanel/`, включает и запускает сервис, сбрасывает кэш LuCI).

- [ ] **Step 1: Написать проверку (падающую)**

`router/tests/run-install.sh` — в корне репозитория запускает `install.sh --dry-run --dest <tmpdir>` и проверяет, что в `<tmpdir>` появились ожидаемые пути (`etc/init.d/homepanel-agent`, `usr/share/ucode/homepanel/agent.uc`, `www/luci-static/resources/view/homepanel/overview.js`, `etc/config/homepanel`), права `0755` на init-скрипт, и что содержимое `etc/homepanel/` — копия `router/files/`.

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `sh router/tests/run-install.sh`
Expected: FAIL (`install.sh: not found`)

- [ ] **Step 3: Реализовать `install.sh`**

Копирует `files/**` в целевой корень (`--dest` по умолчанию `/`), `chmod 0755` на init-скрипт и `agent.uc`, копирует инсталлятор и файлы в `/etc/homepanel/` для переустановки после `sysupgrade`, выполняет `/etc/init.d/homepanel-agent enable && start` (пропускается при `--dry-run`), `reload_config`/`reload rpcd`, `rm -f /tmp/luci-indexcache*`. Идемпотентен.

- [ ] **Step 4: Дописать README и проверить**

Добавить раздел «Роутер»: как скопировать файлы на роутер (`scp -r router root@192.168.1.1:/tmp/`), запустить `install.sh`, заполнить `server_url`/`secret` в LuCI, порядок переустановки после `sysupgrade`, ручной чек-лист (страница LuCI открывается, «Отправить сейчас» даёт `ok:true`, на сервере появляется устройство).

Run: `sh router/tests/run-install.sh`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add router/install.sh router/tests/run-install.sh README.md
git commit -m "feat(router): installer, persistence and documentation"
```

---

## Self-Review

- **Spec coverage:** §4 данные роутера → Task 1; §5 контракт → Task 1/2; §6 агент (ucode/procd/UCI/`--once`/ubus-объект) → Task 1–3; §7 LuCI → Task 4; §15 роутер (install.sh, персистентность `/etc/homepanel/`) → Task 5; §16 тесты (фикстуры, `--once`) → Task 1–5; §17 риски (форма `get_clients`, busybox wget, раскладка LuCI) → учтены в Task 1/2/4.
- **Step scan:** шаги однозначны; код приводится только для фикстур, UCI-умолчаний, `menu.d`/`acl.d` и проверочных скриптов.
- **Type consistency:** `collect`, `read_leases`, `band_of`, `list_bss`, `read_config`, `send_snapshot`, `status_path`, `collect`-override (`--ubus-dir`, `--leases`, `--now`) и объект `homepanel` (`status`/`send`) используются одинаково во всех задачах.
- **Review Focus:** пять классов покрыты — нет `hostapd.*` (Task 1), нет `dhcp.leases` (Task 1), сервер недоступен (Task 2), нет конфига (Task 2), битый ответ (Task 2).
- **Proportion:** план фиксирует решения (имена, пути, форматы), а не реализацию целиком.
