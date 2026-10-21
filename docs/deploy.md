# Развёртывание Home Panel с нуля

Пошаговая инструкция: VPS (или домашний сервер) → DNS → сервер Home Panel →
Nginx Proxy Manager → роутер → приёмка.

Целевая схема:

```
роутер (ucode-агент) --- POST /api/ingest ---> сервер :8787 --- SQLite
                                                   ^
браузер --- HTTPS ---> Nginx Proxy Manager --------+
```

- Сервер — Python 3.11+ (только stdlib), слушает локально/в LAN.
- NPM терминирует TLS и отдаёт панель по HTTPS-домену.
- Агент на роутере отправляет снимки WiFi-клиентов по расписанию.

Время на развёртывание: 20–30 минут.

---

## 0. Что понадобится

- Хост: VPS с Debian 12/13 (минимум 1 ГБ RAM) или домашний сервер.
- Домен или поддомен, например `panel.example.com`, с доступом к DNS.
- Роутер OpenWrt 25.x с установленным агентом (см. §6).
- Nginx Proxy Manager (NPM) — уже работающий или ставится в §4.

Проверьте версию Python на хосте:

```bash
python3 -c 'import sys; print(sys.version)'
```

Нужно 3.11 или новее. В Debian 12 — 3.11, в Debian 13 — 3.13.

---

## 1. DNS

Создайте A-запись:

```
panel.example.com  A  <публичный IP хоста>
```

Если хост домашний и IP динамический — используйте DDNS-провайдера, а в NPM
всё равно указывайте домен.

Проверка (подставьте свой домен):

```bash
dig +short panel.example.com
```

Должен вернуться IP хоста. Если запись ещё не разошлась — подождите TTL.

---

## 2. Подготовка хоста

```bash
sudo apt update
sudo apt install -y git ca-certificates
```

Создайте системного пользователя сервиса:

```bash
sudo useradd --system --create-home --home-dir /home/homepanel \
  --shell /usr/sbin/nologin homepanel
```

Каталог для базы (единственное место, куда сервису нужно писать):

```bash
sudo install -d -o homepanel -g homepanel -m 0750 /var/lib/homepanel
```

---

## 3. Установка сервера

### 3.1. Код

```bash
sudo git clone https://github.com/itdevlog/homepanel.git /home/homepanel/homepanel
sudo chown -R root:root /home/homepanel/homepanel
```

Код остаётся root-owned: сервис запускается под `homepanel` и только читает
его. Если клонируете в другой путь — поправьте `WorkingDirectory` и
`ExecStart` в юните (§3.4), они используют `%h/homepanel`.

### 3.2. Секрет

Секрет — общий для сервера и агента, передаётся в заголовке
`X-Homepanel-Key`. Сгенерируйте 32 байта:

```bash
openssl rand -hex 32
```

Сохраните вывод: он понадобится и здесь, и на роутере.

### 3.3. Конфигурация

```bash
sudo install -Dm640 -o root -g homepanel \
  /home/homepanel/homepanel/server/config.json.example \
  /etc/homepanel/config.json
sudo -e /etc/homepanel/config.json
```

Приведите файл к виду:

```json
{
  "host": "0.0.0.0",
  "port": 8787,
  "secret": "ВСТАВЬТЕ_СЕКРЕТ_ИЗ_3.2",
  "graceSeconds": 300,
  "retention": { "minuteDays": 30, "dailyDays": 365 },
  "publicUrl": "https://panel.example.com",
  "dbPath": "/var/lib/homepanel/homepanel.sqlite3"
}
```

Почему права `0640 root:homepanel`: файл не должен читаться посторонними, но
обязан быть доступен сервису. С `0600 root:root` сервис упадёт с
`Permission denied`.

Параметры:

| Поле | Назначение |
|---|---|
| `host` | `0.0.0.0` — принимать и из LAN (роутер), и от NPM; `127.0.0.1` — только от NPM на том же хосте |
| `port` | порт HTTP, по умолчанию 8787 |
| `secret` | общий секрет с агентом |
| `graceSeconds` | окно дребезга: сколько ждать, прежде чем считать «ушёл» |
| `retention` | сроки хранения минутных/дневных агрегатов |
| `publicUrl` | публичный адрес панели (для ссылок в интерфейсе) |
| `dbPath` | абсолютный путь к SQLite-файлу |

Если сервер и NPM в разных сетях/Docker — см. §4.3: от `host` зависит
доступность из контейнера NPM.

Конфиг читается один раз при старте; после правок — `sudo systemctl restart
homepanel`.

### 3.4. systemd

```bash
sudo install -Dm644 \
  /home/homepanel/homepanel/server/systemd/homepanel.service \
  /etc/systemd/system/homepanel.service
sudo systemctl daemon-reload
sudo systemctl enable --now homepanel
```

Юнит уже рассчитан на `User=homepanel`, `%h` = `/home/homepanel`:

```ini
WorkingDirectory=%h/homepanel/server
ExecStart=/usr/bin/python3 %h/homepanel/server/server.py --config /etc/homepanel/config.json
```

Проверка:

```bash
sudo systemctl status homepanel --no-pager
curl -s http://127.0.0.1:8787/api/state | head -c 300; echo
```

Ожидается JSON со списком устройств (сначала пустой) и код 200:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/state
```

`000` — сервис не слушает; смотрите `journalctl -u homepanel -n 50`.

### 3.5. Если сервис не стартует

```bash
sudo journalctl -u homepanel -n 50 --no-pager
```

| Сообщение | Причина |
|---|---|
| `Permission denied: '/etc/homepanel/config.json'` | права на конфиг (нужно `0640 root:homepanel`) |
| `unable to open database file` | нет прав на каталог из `dbPath` |
| `Address already in use` | порт занят |
| `ModuleNotFoundError` | запущен не тот python (юнит использует `/usr/bin/python3`) |

---

## 4. Nginx Proxy Manager

### 4.1. Если NPM уже работает

Пропустите к §4.2. Важно только, что NPM видит сервер по сети: адрес
`127.0.0.1` внутри контейнера NPM — это сам контейнер, а не хост.

### 4.2. Установка NPM (Docker)

```bash
sudo apt install -y docker.io
# Compose v2: в Debian 13 — из основных репозиториев, в Debian 12 — из backports.
sudo apt install -y docker-compose-v2 \
  || sudo apt install -y -t bookworm-backports docker-compose-v2 \
  || sudo apt install -y docker-compose
sudo mkdir -p /opt/npm && cd /opt/npm
```

`/opt/npm/docker-compose.yml`:

```yaml
services:
  npm:
    image: jc21/nginx-proxy-manager:latest
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "127.0.0.1:81:81"   # админка только с хоста
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./data:/data
      - ./letsencrypt:/etc/letsencrypt
```

```bash
sudo docker compose up -d          # Compose v2
# если установился только Compose v1: sudo docker-compose up -d
```

Админка: `http://127.0.0.1:81` (с удалённой машины — через SSH-туннель:
`ssh -L 8181:127.0.0.1:81 root@хост`, затем `http://127.0.0.1:8181`).

Первый вход: `admin@example.com` / `changeme`, NPM сразу попросит сменить
пароль.

`host.docker.internal` с `host-gateway` позволяет NPM обращаться к серверу,
слушающему на хосте, по имени, а не по IP. Это же имя указывайте в §4.3,
если сервер слушает `0.0.0.0` или адрес хоста.

### 4.3. Прокси-хост для панели

*Hosts → Proxy Hosts → Add Proxy Host*:

- **Domain Names**: `panel.example.com`
- **Scheme**: `http`
- **Forward Hostname / IP**: `host.docker.internal`
- **Forward Port**: `8787`
- **Block Common Exploits**: включить
- **Websockets Support**: можно включить (не требуется, но безвредно)

Вкладка **SSL**:

- *Request a new SSL Certificate* → Let's Encrypt;
- **Force SSL**, **HTTP/2 Support** — включить;
- **I Agree to the Let's Encrypt Terms** — отметить.

Сохранить. Через 10–30 секунд откройте `https://panel.example.com`.

Если сервер и NPM стоят на одном хосте, но сервер слушает только
`127.0.0.1`, контейнер до него не достучится — выставите в конфиге
`host: 0.0.0.0` и ограничьте порт фаерволом (§4.5).

### 4.4. Закрыть панель паролем

Приложение авторизации не имеет. Если панель доступна из интернета, включите
Basic Auth в NPM:

*Access Lists → Add Access List*: имя, пользователь, пароль (bcrypt).
Затем в прокси-хосте панели выберите этот список в поле **Access List**.

Важно: тот же прокси-хост обслуживает `/api/ingest`, а агент роутера Basic
Auth не отправляет. Варианты:

- **Рекомендуется (домашняя сеть):** агент ходит напрямую по LAN —
  `http://<LAN-IP-сервера>:8787/api/ingest`, — а NPM проксирует только
  панель с Access List. Порт 8787 при этом не публикуется в интернет.
- **Если сервер удалён от роутера (VPS, другая площадка):** создайте
  отдельный прокси-хост для приёма (например `ingest.example.com`) без Access
  List и укажите его в `server_url`. Защита — секрет `X-Homepanel-Key`.
- Промежуточный вариант: оставить один хост, а в *Custom Locations*
  добавить `/api/ingest` и в **Advanced** прописать `auth_basic off;`
  (поведение зависит от версии NPM — проверьте, что POST проходит без 401).

### 4.5. Фаервол

Если `ufw` не установлен — `sudo apt install -y ufw`.

Наружу нужны только 80/443 (Let's Encrypt и панель):

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Опубликованные порты контейнеров (`-p` в compose) идут через DNAT и `ufw`
их не фильтрует: 80/443 и так доступны, а `81` в конфиге выше привязан к
`127.0.0.1` и снаружи не виден. Порт `8787` слушает процесс на хосте, поэтому
`ufw` фильтрует его обычным образом.

Порт 8787 не открывайте наружу. Если агенту нужен доступ по LAN, разрешите
его только своей подсети:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp
```

Для Docker-сети NPM (`172.17.0.0/16`) доступ к `8787` обычно уже разрешён
локально; если включали строгие правила — добавьте разрешение для bridge.

---

## 5. Проверка сервера без роутера

Сымитируйте снимок тем же форматом, что отправляет агент:

```bash
curl -s -X POST http://127.0.0.1:8787/api/ingest \
  -H 'Content-Type: application/json' \
  -H 'X-Homepanel-Key: ВАШ_СЕКРЕТ' \
  -d '{
    "schema": 1,
    "agent": { "hostname": "test", "version": "1.0", "ts": 1760000300 },
    "clients": [
      { "mac": "aa:bb:cc:dd:ee:ff", "bss": "phy0-ap0", "band": "2.4",
        "signal": -52, "ip": "192.168.1.42", "hostname": "test-phone" }
    ]
  }'
```

Ожидается `{"ok": true, ...}`. Затем:

```bash
curl -s http://127.0.0.1:8787/api/state | head -c 500; echo
```

Неверный секрет должен давать `401`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:8787/api/ingest \
  -H 'X-Homepanel-Key: wrong' -d '{}'
```

Данные тестового устройства можно удалить из панели (разметка) или оставить —
агент со временем вытеснит его события.

---

## 6. Роутер

### 6.1. Установка агента

На роутере (OpenWrt 25.x), от root:

```bash
wget -O /tmp/hp.sh \
  https://raw.githubusercontent.com/itdevlog/homepanel/main/router/bootstrap.sh \
  && sh /tmp/hp.sh
```

Загрузчик скачает архив репозитория, поставит недостающие ucode-модули
(`apk add ucode-mod-*`), разложит файлы и запустит сервис. Повторный запуск
обновляет файлы и сохраняет текущий `/etc/config/homepanel`.

### 6.2. Настройка

Через LuCI: *Services → Home Panel* — адрес сервера, секрет, интервал,
включение. Или в SSH:

```bash
uci set homepanel.main.enabled='1'
uci set homepanel.main.server_url='http://192.168.1.10:8787/api/ingest'
uci set homepanel.main.secret='ВАШ_СЕКРЕТ'
uci set homepanel.main.interval='30'
uci commit homepanel
```

`server_url` — полный адрес эндпоинта, включая `/api/ingest`. Секрет должен
совпадать с серверным; кавычки в секрете допустимы (агент экранирует
аргументы).

Перезапуск не нужен: агент перечитывает конфиг на каждом тике. Первый снимок
уйдёт в течение `interval` секунд.

### 6.3. Проверка

```bash
ubus call homepanel status
logread -e homepanel | tail -5
```

Успех — `ok: true`, `configured: true`, растущий `client_count` и
`last_error: null`. На сервере:

```bash
curl -s http://127.0.0.1:8787/api/state | head -c 300; echo
sudo journalctl -u homepanel -n 20 --no-pager
```

---

## 7. Приёмка

- [ ] `systemctl is-active homepanel` → `active`
- [ ] `curl http://127.0.0.1:8787/api/state` → 200 и JSON
- [ ] `https://panel.example.com` открывается, сертификат валиден
- [ ] панель закрыта паролем (Access List) или доступна только из LAN
- [ ] `ubus call homepanel status` → `ok: true`, `last_error: null`
- [ ] в панели видны устройства роутера, обновление раз в `interval`
- [ ] при подключении/отключении телефона появляется событие
      «пришёл/ушёл» (с учётом `graceSeconds`)
- [ ] после `reboot` роутера агент поднялся сам:
      `ps w | grep -F agent.uc`
- [ ] после `reboot` сервера поднялся сервис:
      `systemctl is-active homepanel`

---

## 8. Обновление

### Сервер

```bash
cd /home/homepanel/homepanel
sudo git pull
sudo systemctl restart homepanel
curl -s http://127.0.0.1:8787/api/state >/dev/null && echo OK
```

### Роутер

Повторно выполните команду из §6.1 — это штатный способ обновления.

### Прошивка роутера

`sysupgrade` сохраняет `/etc/config/homepanel`, `/etc/homepanel` и
`/etc/init.d/homepanel-agent` (регистрация в `/lib/upgrade/keep.d/homepanel`).
После обновления прошивки переустановите файлы:

```bash
sh /etc/homepanel/install.sh
```

Настройки при этом не перезаписываются.

---

## 9. Бэкап

База — один файл SQLite. Корректная копия без остановки сервиса:

```bash
sudo -u homepanel python3 - <<'PY'
import sqlite3
src = sqlite3.connect("/var/lib/homepanel/homepanel.sqlite3")
dst = sqlite3.connect("/var/lib/homepanel/backup.sqlite3")
src.backup(dst)
dst.close(); src.close()
PY
```

Затем скопируйте `backup.sqlite3` с хоста. Восстановление: остановить сервис,
заменить файл, запустить.

---

## 10. Диагностика

| Симптом | Причина | Что проверить |
|---|---|---|
| Браузер: 502 Bad Gateway | NPM не видит сервер | `Forward Hostname` (`host.docker.internal`), `host: 0.0.0.0`, порт 8787 |
| Браузер: 401 от NPM | включён Access List | это ожидаемо; введите логин/пароль NPM |
| Let's Encrypt: failed | DNS/порт 80 | `dig +short домен`, `ufw status`, доступность 80 извне |
| `ubus call homepanel status` → `ok: false`, `last_error` содержит `unauthorized` | секрет не совпадает | `uci show homepanel`, конфиг сервера |
| `last_error`: `команда отправки завершилась с кодом 4` | connection refused | `server_url`, `host`, фаервол, `curl` с роутера |
| `last_error`: `некорректный ответ сервера: ...` | прокси вернул не JSON (502/HTML) | NPM, адрес `/api/ingest` |
| `ubus call homepanel` → `Not found` | демон не запущен | `/etc/init.d/homepanel-agent status`, `logread -e homepanel` |
| Панель пуста, но `ok: true` | нет данных в БД / чужой `dbPath` | `journalctl -u homepanel` (путь к базе в логе при старте) |
| Время событий «съехало» | часы роутера/сервера | `date`, NTP на обоих |
| Уведомления браузера не работают | не HTTPS или нет разрешения | открывать по HTTPS-домену, разрешить уведомления |

Полезные команды:

```bash
sudo journalctl -u homepanel -f            # сервер
sudo docker logs -f npm                    # NPM (имя контейнера)
ssh root@192.168.1.1 'logread -e homepanel | tail -20'
ssh root@192.168.1.1 'ubus call homepanel status'
curl -sv http://127.0.0.1:8787/api/state   # локально, мимо прокси
```

---

## 11. Что дальше

- Уведомления при закрытой вкладке (Web Push), Telegram-бот, несколько
  роутеров — направления развития, см. спеку
  `docs/superpowers/specs/2026-10-18-homepanel-design.md`.
- Упаковка роутерной части в `.apk` — будущая итерация; сейчас обновление
  через bootstrap-скрипт.
