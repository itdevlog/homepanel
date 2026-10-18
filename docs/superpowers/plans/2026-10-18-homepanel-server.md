# Home Panel — Server & Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сервер на Python (только stdlib) + SQLite, принимающий снимки присутствия от роутера, и ванильная веб-панель, показывающая «кто дома», разметку устройств, историю и уведомления.

**Architecture:** Пакет `homepanel` под `server/` (конфиг → хранилище SQLite → парсинг снимка → автомат присутствия → агрегаты → тонкий HTTP-слой). Панель — статические ES-модули без сборки, общающиеся с JSON-API; чистая логика панели вынесена в `lib.js` и тестируется Node.

**Tech Stack:** Python 3.11 (stdlib: `http.server`, `sqlite3`, `json`, `threading`, `unittest`), SQLite (WAL), vanilla HTML/CSS/JS (ES modules), Node 18 `node --test` для тестов чистой логики панели.

**Spec:** `docs/superpowers/specs/2026-10-18-homepanel-design.md`

## Global Constraints

- Только стандартная библиотека Python 3 — никаких сторонних зависимостей.
- Фронтенд — ванильный HTML/CSS/JS (ES-модули), **без сборки и без npm-зависимостей**.
- Время в БД — epoch-секунды UTC (int). Дневные/часовые бакеты — в локальной таймзоне сервера.
- SQLite открывается с `PRAGMA journal_mode=WAL`; доступ через `threading.Lock` (`check_same_thread=False`).
- JSON-ответы — UTF-8, `json.dumps(..., ensure_ascii=False)`.
- Ошибки API: HTTP-код + тело `{"error": {"reason": "<code>", "message": "<текст>"}}`.
- Секрет передаётся заголовком `X-Homepanel-Key`; несовпадение → `401`.
- `schema` снимка: целое, максимум `1`; больше → `400`.
- Порты/умолчания: `host=127.0.0.1`, `port=8787`, `graceSeconds=300`, `minuteDays=30`, `dailyDays=365`.
- Пользовательские строки интерфейса — по-русски; идентификаторы и имена в коде — по-английски.
- Все команды запускаются из каталога `server/`; тесты — `python3 -m unittest discover -s tests -v`.
- Каждый коммит — законченный, тесты зелёные.

## Review Focus

Классы входных данных/сбоев, которые спека подразумевает, но ни один тест задачи прямо не диктует. Для каждой — тест в задаче-владельце:

1. **Обход каталога при отдаче статики** (`GET /../config.json`, URL-кодированные `%2e%2e`) — ожидание: `404`, файл вне `static_dir` не отдаётся. (Task 8)
2. **Слишком большое тело `/api/ingest`** — ожидание: запрос сверх лимита (`MAX_BODY = 1 MiB`) отклоняется с `413`, сервер не падает. (Task 8)
3. **Сдвиг часов / `agent.ts` из прошлого или будущего** — ожидание: логика присутствия использует собственные `now` сервера, `agent.ts` не влияет на `last_seen`/`since`. (Task 5)
4. **Один MAC в нескольких BSS внутри одного снимка** — ожидание: запись одна, выбирается клиент с сильнейшим сигналом, нет двойного `arrived`. (Task 5)
5. **Пустой список `clients` и невалидное тело** — ожидание: не-JSON/не-объект → `400`; пустой `clients` — валиден и приводит к истечению всех устройств по grace. (Task 4 и Task 5)

---

### Task 1: Модуль конфигурации

**Files:**
- Create: `server/homepanel/__init__.py`
- Create: `server/homepanel/config.py`
- Create: `server/config.json.example`
- Test: `server/tests/__init__.py`, `server/tests/test_config.py`

**Interfaces:**
- Consumes: —
- Produces: `load_config(path: str | None = None) -> Config`; `@dataclass Config` с полями `host: str, port: int, secret: str, grace_seconds: int, minute_retention_days: int, daily_retention_days: int, public_url: str, db_path: str, static_dir: str`.

- [ ] **Step 1: Написать падающий тест**

```python
# server/tests/test_config.py
import json, os, tempfile, unittest
from homepanel.config import load_config

class ConfigTest(unittest.TestCase):
    def test_defaults_when_no_path(self):
        c = load_config(None)
        self.assertEqual((c.host, c.port, c.secret), ("127.0.0.1", 8787, "CHANGE_ME"))
        self.assertEqual((c.grace_seconds, c.minute_retention_days, c.daily_retention_days),
                         (300, 30, 365))

    def test_file_overrides_and_unknown_keys_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "config.json")
            with open(p, "w") as f:
                json.dump({"port": 9999, "graceSeconds": 60, "bogus": 1}, f)
            c = load_config(p)
            self.assertEqual((c.port, c.grace_seconds), (9999, 60))

    def test_missing_file_is_defaults(self):
        self.assertEqual(load_config("/nonexistent/x.json").port, 8787)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && python3 -m unittest tests.test_config -v`
Expected: FAIL (`ModuleNotFoundError: homepanel.config`)

- [ ] **Step 3: Реализовать `load_config` в `server/homepanel/config.py`**

Umlauts: JSON-ключи `host`, `port`, `secret`, `graceSeconds`, `retention:{minuteDays,dailyDays}`, `publicUrl`, `dbPath`, `staticDir`. Читает файл если существует и путь не `None`; неизвестные ключи игнорирует; отсутствующий файл → умолчания. `db_path` по умолчанию `os.path.join("data", "homepanel.sqlite3")`, `static_dir` → `os.path.join(os.path.dirname(__file__), "..", "static")` (нормализовать). Создать `server/config.json.example` с полями из спеки §14.

- [ ] **Step 4: Прогнать тест**

Run: `cd server && python3 -m unittest tests.test_config -v`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/homepanel/__init__.py server/homepanel/config.py server/config.json.example server/tests/__init__.py server/tests/test_config.py
git commit -m "feat(server): config module and example config"
```

---

### Task 2: Хранилище — схема и реестр устройств

**Files:**
- Create: `server/homepanel/store.py`
- Test: `server/tests/test_store.py`

**Interfaces:**
- Consumes: —
- Produces: `class Store` с `__init__(self, path: str)`, `close(self) -> None`, `get_devices(self) -> list[dict]`, `get_device(self, mac: str) -> dict | None`, `upsert_device(self, mac: str, **fields) -> dict`, `merge_devices(self, src_mac: str, dst_mac: str) -> dict`. Поля устройства: `mac, name, person, kind, trust, hidden, notes, created_at, updated_at`. Также `Store._lock` (`threading.Lock`).

- [ ] **Step 1: Написать падающий тест**

```python
# server/tests/test_store.py
import os, tempfile, unittest
from homepanel.store import Store

class DevicesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.sqlite3"))

    def tearDown(self):
        self.store.close(); self.dir.cleanup()

    def test_upsert_insert_then_partial_update(self):
        d = self.store.upsert_device("AA:BB:CC:DD:EE:FF", name="Телефон", person="Иван")
        self.assertEqual(d["mac"], "aa:bb:cc:dd:ee:ff")   # нормализация в нижний регистр
        self.assertEqual(d["trust"], "unknown")
        d2 = self.store.upsert_device("aa:bb:cc:dd:ee:ff", kind="phone")
        self.assertEqual((d2["name"], d2["kind"], d2["person"]), ("Телефон", "phone", "Иван"))

    def test_merge_moves_reference_and_deletes_source(self):
        self.store.upsert_device("aa:aa:aa:aa:aa:aa", name="Старый")
        self.store.upsert_device("bb:bb:bb:bb:bb:bb", person="Иван")
        merged = self.store.merge_devices("aa:aa:aa:aa:aa:aa", "bb:bb:bb:bb:bb:bb")
        self.assertEqual(merged["person"], "Иван")
        self.assertIsNone(self.store.get_device("aa:aa:aa:aa:aa:aa"))
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && python3 -m unittest tests.test_store -v`
Expected: FAIL (`ModuleNotFoundError: homepanel.store`)

- [ ] **Step 3: Реализовать `Store`**

`__init__` открывает `sqlite3.connect(path, check_same_thread=False)`, включает WAL, создаёт все таблицы и индексы из спеки §9 (`devices, presence, events, minute_presence, daily_presence`). `upsert_device` нормализует MAC (`mac.lower()`), при обновлении меняет только переданные не-`None` поля, проставляет `updated_at`. `merge_devices(src, dst)` переносит непустые поля src в dst (не перетирая непустые поля dst), удаляет src и его `presence`.

- [ ] **Step 4: Прогнать тест**

Run: `cd server && python3 -m unittest tests.test_store -v`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/homepanel/store.py server/tests/test_store.py
git commit -m "feat(server): sqlite store schema and device registry"
```

---

### Task 3: Хранилище — присутствие, события, агрегаты

**Files:**
- Modify: `server/homepanel/store.py`
- Test: `server/tests/test_store.py`

**Interfaces:**
- Consumes: `Store` (Task 2)
- Produces (методы `Store`):
  - `get_presence(mac) -> dict | None`, `all_presence() -> list[dict]`, `set_presence(mac, **fields) -> None` (поля: `state, last_seen, since, bss, band, signal, ip, hostname, updated_at`);
  - `add_event(mac, type, ts, **fields) -> int` (поля `bss, band, ip`), `get_events(since_id: int | None = None, limit: int = 200) -> list[dict]` — при `since_id` возвращает события с `id > since_id` по возрастанию `id`; при `None` — последние `limit` по возрастанию;
  - `mark_minute(mac, minute_ts) -> None`, `minutes_by_hour(from_ts, to_ts, macs=None) -> list[dict]` (`{"hour_ts", "minutes"}`), `minutes_by_day(from_ts, to_ts, macs=None) -> list[dict]` (`{"day", "minutes"}`, `day` = `YYYY-MM-DD` локально), `minutes_for_day(day, macs=None) -> dict[str, int]`, `upsert_daily(mac, day, minutes) -> None`, `prune_minutes(before_ts) -> int`, `prune_daily(before_day) -> int`.

- [ ] **Step 1: Написать падающий тест**

```python
    # добавляется в DevicesTest
    def test_presence_and_events_roundtrip(self):
        self.store.set_presence("aa:bb:cc:dd:ee:ff", state="home", last_seen=1000, since=1000)
        self.assertEqual(self.store.get_presence("aa:bb:cc:dd:ee:ff")["state"], "home")
        e1 = self.store.add_event("aa:bb:cc:dd:ee:ff", "arrived", 1000)
        e2 = self.store.add_event("aa:bb:cc:dd:ee:ff", "left", 1300)
        self.assertEqual([e["type"] for e in self.store.get_events(since_id=e1)], ["left"])
        self.assertEqual(self.store.get_events(limit=1)[0]["id"], e2)

    def test_minute_aggregates_and_prune(self):
        mac = "aa:bb:cc:dd:ee:ff"
        for m in (60, 120, 120):
            self.store.mark_minute(mac, m)          # повтор игнорируется (PK)
        self.assertEqual(self.store.minutes_by_hour(0, 200)[0]["minutes"], 2)
        self.assertEqual(self.store.minutes_by_day(0, 200)[0]["minutes"], 2)
        self.assertEqual(self.store.prune_minutes(200), 2)
        self.assertEqual(self.store.prune_minutes(200), 0)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && python3 -m unittest tests.test_store -v`
Expected: FAIL (`AttributeError: 'Store' object has no attribute 'set_presence'`)

- [ ] **Step 3: Реализовать методы**

`mark_minute` — `INSERT OR IGNORE`. `minutes_by_hour` — `GROUP BY minute_ts/3600` с возвратом `hour_ts`. `minutes_by_day` — группировка по локальной дате (`time.localtime`). `macs` — фильтр `WHERE mac IN (...)` когда передан. Все запросы под `self._lock`.

- [ ] **Step 4: Прогнать тест**

Run: `cd server && python3 -m unittest tests.test_store -v`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/homepanel/store.py server/tests/test_store.py
git commit -m "feat(server): presence, events and aggregate queries"
```

---

### Task 4: Разбор снимка `/api/ingest`

**Files:**
- Create: `server/homepanel/ingest.py`
- Test: `server/tests/test_ingest.py`

**Interfaces:**
- Consumes: —
- Produces: `class IngestError(Exception)`; `@dataclass Client(mac, bss, band, signal, ip, hostname, connected_at)`; `@dataclass Snapshot(schema, agent_hostname, agent_version, ts, clients)`; `parse_snapshot(raw: bytes) -> Snapshot` (бросает `IngestError`).

- [ ] **Step 1: Написать падающий тест**

```python
# server/tests/test_ingest.py
import json, unittest
from homepanel.ingest import parse_snapshot, IngestError

VALID = {"schema": 1, "agent": {"hostname": "OpenWrt", "version": "1.0", "ts": 1760000000},
         "clients": [{"mac": "AA:BB:CC:DD:EE:FF", "bss": "phy0-ap0", "band": "2.4",
                      "signal": -52, "ip": "192.168.1.42", "hostname": "iPhone"}]}

class IngestTest(unittest.TestCase):
    def test_parses_and_normalizes(self):
        s = parse_snapshot(json.dumps(VALID).encode())
        self.assertEqual(s.schema, 1)
        self.assertEqual(s.clients[0].mac, "aa:bb:cc:dd:ee:ff")

    def test_rejects_non_json_and_non_object(self):
        for raw in (b"not json", b"[1,2,3]", b"null"):
            with self.assertRaises(IngestError):
                parse_snapshot(raw)

    def test_rejects_schema_above_one(self):
        bad = dict(VALID, schema=2)
        with self.assertRaises(IngestError):
            parse_snapshot(json.dumps(bad).encode())

    def test_skips_malformed_clients_but_empty_list_is_valid(self):
        bad = dict(VALID, clients=[{"mac": "nope"}, {"bss": "x"}])
        self.assertEqual(parse_snapshot(json.dumps(bad).encode()).clients, [])
        self.assertEqual(parse_snapshot(json.dumps(dict(VALID, clients=[])).encode()).clients, [])
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && python3 -m unittest tests.test_ingest -v`
Expected: FAIL (`ModuleNotFoundError: homepanel.ingest`)

- [ ] **Step 3: Реализовать `parse_snapshot`**

Валидация MAC регуляркой `^[0-9a-f]{2}(:[0-9a-f]{2}){5}$` после `.lower()`. Отсутствие/не-список `clients` → `IngestError`; некорректные элементы списка пропускаются. `schema` отсутствует → трактуется как `1`; `schema > 1` → `IngestError`. `signal`/`connected_at` приводятся к int при возможности, иначе `None`.

- [ ] **Step 4: Прогнать тест**

Run: `cd server && python3 -m unittest tests.test_ingest -v`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/homepanel/ingest.py server/tests/test_ingest.py
git commit -m "feat(server): ingest payload parsing and validation"
```

---

### Task 5: Автомат присутствия

**Files:**
- Create: `server/homepanel/presence.py`
- Test: `server/tests/test_presence.py`

**Interfaces:**
- Consumes: `Store` (Task 2–3), `Snapshot`/`Client` (Task 4)
- Produces: `class PresenceEngine` с `__init__(self, store: Store, grace_seconds: int)`, `apply_snapshot(self, snap: Snapshot, now: int) -> dict` (возвращает `{"arrived": [...macs], "updated": [...]}`), `expire(self, now: int) -> list[dict]` (созданные события `left`).

- [ ] **Step 1: Написать падающий тест**

```python
# server/tests/test_presence.py
import os, tempfile, unittest
from homepanel.store import Store
from homepanel.ingest import parse_snapshot
from homepanel.presence import PresenceEngine
import json

def snap(clients, ts=1000):
    return parse_snapshot(json.dumps(
        {"schema": 1, "agent": {"hostname": "r", "version": "1", "ts": ts},
         "clients": clients}).encode())

CL = [{"mac": "aa:bb:cc:dd:ee:ff", "bss": "phy0-ap0", "band": "2.4", "signal": -50}]

class PresenceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.sqlite3"))
        self.eng = PresenceEngine(self.store, grace_seconds=300)

    def tearDown(self):
        self.store.close(); self.dir.cleanup()

    def test_arrival_then_expiry_after_grace(self):
        r = self.eng.apply_snapshot(snap(CL), now=1000)
        self.assertEqual(r["arrived"], ["aa:bb:cc:dd:ee:ff"])
        self.assertEqual(self.store.get_presence("aa:bb:cc:dd:ee:ff")["state"], "home")
        self.assertEqual(self.eng.expire(now=1200), [])            # grace не истёк
        left = self.eng.expire(now=1400)                            # 1000+300 < 1400
        self.assertEqual([e["type"] for e in left], ["left"])
        self.assertEqual(self.store.get_presence("aa:bb:cc:dd:ee:ff")["state"], "away")

    def test_repeated_snapshot_is_idempotent(self):
        self.eng.apply_snapshot(snap(CL), now=1000)
        r = self.eng.apply_snapshot(snap(CL), now=1010)
        self.assertEqual(r["arrived"], [])
        self.assertEqual(len(self.store.get_events()), 1)

    def test_agent_ts_does_not_move_server_now(self):        # Review Focus 3
        self.eng.apply_snapshot(snap(CL, ts=9_999_999), now=1000)
        self.assertEqual(self.store.get_presence("aa:bb:cc:dd:ee:ff")["last_seen"], 1000)

    def test_same_mac_on_two_bss_kept_once_with_strongest_signal(self):   # Review Focus 4
        two = [dict(CL[0], bss="phy0-ap0", signal=-70), dict(CL[0], bss="phy1-ap0", signal=-45)]
        r = self.eng.apply_snapshot(snap(two), now=1000)
        p = self.store.get_presence("aa:bb:cc:dd:ee:ff")
        self.assertEqual(r["arrived"], ["aa:bb:cc:dd:ee:ff"])
        self.assertEqual((p["bss"], p["signal"]), ("phy1-ap0", -45))
        self.assertEqual(len(self.store.get_events()), 1)

    def test_empty_clients_expires_everyone(self):           # Review Focus 5
        self.eng.apply_snapshot(snap(CL), now=1000)
        self.eng.apply_snapshot(snap([]), now=1010)
        self.assertEqual([e["type"] for e in self.eng.expire(now=1400)], ["left"])
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && python3 -m unittest tests.test_presence -v`
Expected: FAIL (`ModuleNotFoundError: homepanel.presence`)

- [ ] **Step 3: Реализовать `PresenceEngine`**

`apply_snapshot`: сгруппировать клиентов по MAC, при дублировании оставить с наибольшим `signal`; для каждого — предыдущая запись из `get_presence`; если её нет или `state != "home"` → `add_event("arrived", now)`, `since = now`; иначе сохранить существующий `since`. `last_seen` всегда = `now`, `updated_at = now`. `expire(now)`: для всех `state == "home"` c `now - last_seen > grace_seconds` → `add_event("left", now)`, `set_presence(state="away")`.

- [ ] **Step 4: Прогнать тест**

Run: `cd server && python3 -m unittest tests.test_presence -v`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/homepanel/presence.py server/tests/test_presence.py
git commit -m "feat(server): presence state machine with grace window"
```

---

### Task 6: Агрегация минут, дневной роллап и очистка

**Files:**
- Create: `server/homepanel/aggregator.py`
- Test: `server/tests/test_aggregator.py`

**Interfaces:**
- Consumes: `Store`, `PresenceEngine` (Task 3, 5)
- Produces: `record_minutes(store: Store, now: int) -> int` (число помеченных MAC), `rollup_daily(store: Store, day: str) -> int` (число устройств), `prune(store: Store, now: int, minute_days: int, daily_days: int) -> dict` (`{"minutes": n, "days": n}`), `day_key(ts: int) -> str`.

- [ ] **Step 1: Написать падающий тест**

```python
# server/tests/test_aggregator.py
import os, tempfile, unittest
from homepanel.store import Store
from homepanel import aggregator

class AggregatorTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.sqlite3"))

    def tearDown(self):
        self.store.close(); self.dir.cleanup()

    def test_records_only_home_devices_for_current_minute(self):
        self.store.set_presence("aa:aa:aa:aa:aa:aa", state="home", last_seen=1000, since=1000)
        self.store.set_presence("bb:bb:bb:bb:bb:bb", state="away", last_seen=1000, since=1000)
        self.assertEqual(aggregator.record_minutes(self.store, now=3725), 1)  # минута 3720
        self.assertEqual(self.store.minutes_by_day(0, 4000)[0]["minutes"], 1)

    def test_rollup_then_prune(self):
        self.store.mark_minute("aa:aa:aa:aa:aa:aa", 60)
        self.store.mark_minute("aa:aa:aa:aa:aa:aa", 120)
        day = aggregator.day_key(120)
        self.assertEqual(aggregator.rollup_daily(self.store, day), 1)
        self.assertEqual(self.store.minutes_for_day(day)["aa:aa:aa:aa:aa:aa"], 2)
        self.assertEqual(aggregator.rollup_daily(self.store, day), 1)          # идемпотентно
        res = aggregator.prune(self.store, now=200, minute_days=0, daily_days=0)
        self.assertEqual(res["minutes"], 0)                                     # 200 с > 60 с
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && python3 -m unittest tests.test_aggregator -v`
Expected: FAIL (`ModuleNotFoundError: homepanel.aggregator`)

- [ ] **Step 3: Реализовать `aggregator.py`**

`day_key(ts)` — `time.strftime("%Y-%m-%d", time.localtime(ts))`. `record_minutes` — `minute_ts = now - now % 60`, помечает все `state == "home"` из `all_presence()`. `rollup_daily(day)` — `minutes_for_day(day)` → `upsert_daily` (перезапись значения, идемпотентно). `prune(now, minute_days, daily_days)` — `prune_minutes(now - minute_days*86400)` и `prune_daily(day_key(now - daily_days*86400))`.

- [ ] **Step 4: Прогнать тест**

Run: `cd server && python3 -m unittest tests.test_aggregator -v`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/homepanel/aggregator.py server/tests/test_aggregator.py
git commit -m "feat(server): minute recording, daily rollup and retention prune"
```

---

### Task 7: Статистика для графиков

**Files:**
- Create: `server/homepanel/stats.py`
- Test: `server/tests/test_stats.py`

**Interfaces:**
- Consumes: `Store` (Task 3), `day_key` (Task 6)
- Produces: `compute_stats(store: Store, *, group: str, from_day: str, to_day: str, macs: list[str] | None = None) -> list[dict]` → список `{"bucket": str, "minutes": int}` по возрастанию; `group ∈ {"hour", "day", "week"}`; `week_key(day: str) -> str` (`YYYY-Www`), `day_bounds(from_day, to_day) -> tuple[int, int]`.

- [ ] **Step 1: Написать падающий тест**

```python
# server/tests/test_stats.py
import os, tempfile, unittest, time
from homepanel.store import Store
from homepanel import stats, aggregator

class StatsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.sqlite3"))

    def tearDown(self):
        self.store.close(); self.dir.cleanup()

    def test_week_and_day_grouping(self):
        # две минуты в один локальный день
        noon = int(time.mktime(time.strptime("2026-10-14 12:00", "%Y-%m-%d %H:%M")))
        self.store.mark_minute("aa:aa:aa:aa:aa:aa", noon)
        self.store.mark_minute("aa:aa:aa:aa:aa:aa", noon + 60)
        self.store.mark_minute("bb:bb:bb:bb:bb:bb", noon)
        aggregator.rollup_daily(self.store, "2026-10-14")
        rows = stats.compute_stats(self.store, group="day", from_day="2026-10-14", to_day="2026-10-14")
        self.assertEqual(rows, [{"bucket": "2026-10-14", "minutes": 3}])
        wk = stats.compute_stats(self.store, group="week", from_day="2026-10-14", to_day="2026-10-14")
        self.assertEqual(wk, [{"bucket": stats.week_key("2026-10-14"), "minutes": 3}])

    def test_mac_filter(self):
        noon = int(time.mktime(time.strptime("2026-10-14 12:00", "%Y-%m-%d %H:%M")))
        self.store.mark_minute("aa:aa:aa:aa:aa:aa", noon)
        self.store.mark_minute("bb:bb:bb:bb:bb:bb", noon)
        rows = stats.compute_stats(self.store, group="hour", from_day="2026-10-14",
                                   to_day="2026-10-14", macs=["aa:aa:aa:aa:aa:aa"])
        self.assertEqual(sum(r["minutes"] for r in rows), 1)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && python3 -m unittest tests.test_stats -v`
Expected: FAIL (`ModuleNotFoundError: homepanel.stats`)

- [ ] **Step 3: Реализовать `stats.py`**

`day_bounds` — epoch-границы локальных суток `from_day`/`to_day`. `compute_stats`:
- `day` → сумма `minutes_by_day(...)`.
- `week` → из `minutes_by_day(...)` суммирует минуты по неделям через `week_key(day)`.
- `hour` → `minutes_by_hour(day_bounds(...))`, bucket = локальная строка `YYYY-MM-DDTHH`.
Результат отсортирован по bucket.

- [ ] **Step 4: Прогнать тест**

Run: `cd server && python3 -m unittest tests.test_stats -v`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/homepanel/stats.py server/tests/test_stats.py
git commit -m "feat(server): stats computation for hour/day/week buckets"
```

---

### Task 8: Логика приложения и HTTP-слой

**Files:**
- Create: `server/homepanel/app.py`
- Test: `server/tests/test_api.py`

**Interfaces:**
- Consumes: `Config` (Task 1), `Store` (Task 2–3), `parse_snapshot`/`IngestError` (Task 4), `PresenceEngine` (Task 5), `compute_stats` (Task 7)
- Produces: `class App` с `__init__(self, config: Config, store: Store, engine: PresenceEngine, clock=time.time)`, `handle_ingest(self, payload: bytes, key: str | None, now: int) -> tuple[int, dict]`, `state(self, now: int) -> dict`, `list_devices(self) -> list[dict]`, `update_device(self, body: dict, now: int) -> dict`, `list_events(self, since_id: int | None, limit: int) -> list[dict]`, `stats(self, query: dict, now: int) -> list[dict]`, `make_handler(self) -> type[BaseHTTPRequestHandler]`. Константа `MAX_BODY = 1024 * 1024`.

- [ ] **Step 1: Написать падающий тест**

```python
# server/tests/test_api.py
import json, os, tempfile, threading, unittest, urllib.request, urllib.error
from homepanel.config import load_config
from homepanel.store import Store
from homepanel.presence import PresenceEngine
from homepanel.app import App

def make_app(tmp):
    cfg = load_config(None); cfg.secret = "s3cr3t"; cfg.static_dir = os.path.join(tmp, "static")
    os.makedirs(cfg.static_dir, exist_ok=True)
    store = Store(os.path.join(tmp, "t.sqlite3"))
    return cfg, store, App(cfg, store, PresenceEngine(store, 300))

class ApiTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.cfg, self.store, self.app = make_app(self.dir.name)
        self.srv = __import__("http.server", fromlist=["HTTPServer"]).HTTPServer(
            ("127.0.0.1", 0), self.app.make_handler())
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.port}"

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close(); self.store.close(); self.dir.cleanup()

    def _post(self, body: bytes, key=None):
        req = urllib.request.Request(self.base + "/api/ingest", data=body,
                                     headers={"Content-Type": "application/json",
                                              **({"X-Homepanel-Key": key} if key else {})})
        return urllib.request.urlopen(req)

    def test_ingest_requires_secret(self):
        body = json.dumps({"schema": 1, "clients": []}).encode()
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._post(body, key="wrong")
        self.assertEqual(e.exception.code, 401)

    def test_ingest_then_state(self):
        body = json.dumps({"schema": 1, "agent": {"hostname": "r", "version": "1", "ts": 1},
                           "clients": [{"mac": "aa:bb:cc:dd:ee:ff", "signal": -40}]}).encode()
        self.assertEqual(json.loads(self._post(body, key="s3cr3t").read())["ok"], True)
        state = json.loads(urllib.request.urlopen(self.base + "/api/state").read())
        self.assertEqual(state["devices"][0]["state"], "home")

    def test_oversized_body_rejected(self):                 # Review Focus 2
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._post(b"x" * (2 * 1024 * 1024), key="s3cr3t")
        self.assertEqual(e.exception.code, 413)

    def test_static_path_traversal_blocked(self):           # Review Focus 1
        secret_file = os.path.join(os.path.dirname(self.cfg.static_dir), "secret.txt")
        with open(secret_file, "w") as f: f.write("nope")
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(self.base + "/../secret.txt")
        self.assertEqual(e.exception.code, 404)

    def test_update_device_and_stats_endpoints(self):
        req = urllib.request.Request(self.base + "/api/devices",
              data=json.dumps({"mac": "aa:bb:cc:dd:ee:ff", "name": "Телефон", "person": "Иван"}).encode(),
              headers={"Content-Type": "application/json"}, method="POST")
        self.assertEqual(json.loads(urllib.request.urlopen(req).read())["name"], "Телефон")
        rows = json.loads(urllib.request.urlopen(
            self.base + "/api/stats?group=day&from=2026-10-14&to=2026-10-14").read())
        self.assertEqual(rows, [])
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && python3 -m unittest tests.test_api -v`
Expected: FAIL (`ModuleNotFoundError: homepanel.app`)

- [ ] **Step 3: Реализовать `App` и `make_handler`**

`App` реализует методы, возвращающие сериализуемые структуры (`state` объединяет устройства+присутствие+сводку по людям+`agent`). `make_handler()` возвращает подкласс `BaseHTTPRequestHandler` с `do_GET`/`do_POST`, обёрнутый в замыкание с `self` (App). Правила:
- `/api/ingest`: `Content-Length` > `MAX_BODY` → `413`; ключ != `config.secret` → `401`; `IngestError` → `400`; иначе `engine.apply_snapshot(parse_snapshot(payload), now=int(clock()))`.
- `/api/state`, `/api/devices` (GET/POST), `/api/events`, `/api/stats` — по спеке §11; неизвестный `/api/*` → `404`.
- Статика: путь через `os.path.normpath`, итоговый абсолютный путь обязан лежать внутри `static_dir`, иначе `404`; `/` → `index.html`; неизвестный MIME → `application/octet-stream`; `Content-Type` по расширению.
- Ошибки сериализуются как `{"error": {"reason", "message"}}`. Логирование — `logging`.

- [ ] **Step 4: Прогнать тест**

Run: `cd server && python3 -m unittest tests.test_api -v`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/homepanel/app.py server/tests/test_api.py
git commit -m "feat(server): application logic and HTTP API with static serving"
```

---

### Task 9: Фоновый планировщик

**Files:**
- Create: `server/homepanel/scheduler.py`
- Test: `server/tests/test_scheduler.py`

**Interfaces:**
- Consumes: `Store`, `PresenceEngine`, `aggregator`
- Produces: `class Scheduler` с `__init__(self, store, engine, *, minute_days, daily_days, tick_seconds=15, clock=time.time)`, `run_once(self, now: int) -> dict` (возвращает `{"expired": n, "minutes": n, "rolled_day": str | None}`), `start(self) -> None`, `stop(self) -> None`.

- [ ] **Step 1: Написать падающий тест**

```python
# server/tests/test_scheduler.py
import os, tempfile, unittest
from homepanel.store import Store
from homepanel.presence import PresenceEngine
from homepanel.scheduler import Scheduler

class SchedulerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.sqlite3"))
        self.sched = Scheduler(self.store, PresenceEngine(self.store, 300),
                               minute_days=30, daily_days=365)

    def tearDown(self):
        self.store.close(); self.dir.cleanup()

    def test_run_once_expires_and_records_minutes(self):
        self.store.set_presence("aa:aa:aa:aa:aa:aa", state="home", last_seen=1000, since=1000)
        res = self.sched.run_once(now=2000)          # grace истёк
        self.assertEqual(res["expired"], 1)
        self.assertEqual(self.store.get_presence("aa:aa:aa:aa:aa:aa")["state"], "away")

    def test_run_once_is_safe_when_nothing_to_do(self):
        self.assertEqual(self.sched.run_once(now=2000)["expired"], 0)
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && python3 -m unittest tests.test_scheduler -v`
Expected: FAIL (`ModuleNotFoundError: homepanel.scheduler`)

- [ ] **Step 3: Реализовать `Scheduler`**

`run_once(now)`: `engine.expire(now)` → `aggregator.record_minutes(store, now)`; если локальная дата отличается от даты последнего роллапа `self._last_day` → `rollup_daily(previous_day)` + `prune(...)`, обновить `_last_day`. `start()` запускает демон-поток с циклом `run_once(self._clock())` + `sleep(tick_seconds)`; `stop()` выставляет `threading.Event`.

- [ ] **Step 4: Прогнать тест**

Run: `cd server && python3 -m unittest tests.test_scheduler -v`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/homepanel/scheduler.py server/tests/test_scheduler.py
git commit -m "feat(server): background scheduler for expiry and aggregates"
```

---

### Task 10: Точка входа, системный юнит, README

**Files:**
- Create: `server/server.py`
- Create: `server/systemd/homepanel.service`
- Modify: `README.md` (создать)
- Test: `server/tests/test_server_entry.py`

**Interfaces:**
- Consumes: всё выше (Task 1–9)
- Produces: `build_app(config: Config) -> tuple[App, Scheduler]` в `server/server.py`; CLI `python3 server.py [--config PATH]`.

- [ ] **Step 1: Написать падающий тест**

```python
# server/tests/test_server_entry.py
import os, tempfile, unittest
from homepanel.config import load_config
from server import build_app

class EntryTest(unittest.TestCase):
    def test_build_app_wires_components(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = load_config(None); cfg.db_path = os.path.join(d, "t.sqlite3")  # noqa
            app, sched = build_app(cfg)
            self.assertIsNotNone(app.make_handler())
            self.assertEqual(sched.run_once(0)["expired"], 0)
            app.store.close()
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd server && python3 -m unittest tests.test_server_entry -v`
Expected: FAIL (`ModuleNotFoundError: server`)

- [ ] **Step 3: Реализовать `server/server.py` + юнит + README**

`build_app` создаёт `Store`, `PresenceEngine`, `App`, `Scheduler`. `main()` читает `--config` через `load_config`, поднимает `ThreadingHTTPServer((cfg.host, cfg.port), app.make_handler())`, стартует планировщик, пишет строку старта в stdout, ждёт `KeyboardInterrupt`. `server/systemd/homepanel.service` — `ExecStart=/usr/bin/python3 %h/homepanel/server/server.py --config /etc/homepanel/config.json`, `Restart=on-failure`, `WorkingDirectory=<server>`. `README.md`: установка, `config.json`, systemd, Nginx Proxy Manager (прокси на `127.0.0.1:8787`, TLS, `/api/ingest` доступен с IP роутера), безопасность.

- [ ] **Step 4: Прогнать все тесты сервера**

Run: `cd server && python3 -m unittest discover -s tests -v`
Expected: PASS (все)

- [ ] **Step 5: Коммит**

```bash
git add server/server.py server/systemd/homepanel.service README.md server/tests/test_server_entry.py
git commit -m "feat(server): entrypoint, systemd unit and README"
```

---

### Task 11: Панель — чистые помощники (`lib.js`)

**Files:**
- Create: `server/static/lib.js`
- Test: `server/tests/js/lib.test.mjs`

**Interfaces:**
- Consumes: —
- Produces (ES-модуль `static/lib.js`): `formatDuration(seconds: number) -> string`, `groupPeople(devices: object[]) -> object[]` (по `person`, `home` = есть неотмеченное `hidden` устройство `state === "home"`; `since` = минимум `since` среди домашних), `diffEvents(events: object[], lastId: number) -> object[]` (события с `id > lastId`), `barsFromStats(rows: object[]) -> {label: string, value: number}[]`.

- [ ] **Step 1: Написать падающий тест**

```js
// server/tests/js/lib.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, groupPeople, diffEvents, barsFromStats } from "../../static/lib.js";

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0 мин");
  assert.equal(formatDuration(90 * 60), "1 ч 30 мин");
  assert.equal(formatDuration(3600 * 26), "1 д 2 ч");
});

test("groupPeople marks home and earliest since", () => {
  const rows = groupPeople([
    { person: "Иван", state: "home", since: 200, hidden: false },
    { person: "Иван", state: "home", since: 100, hidden: false },
    { person: "Анна", state: "away", since: 100, hidden: false },
    { person: "Пётр", state: "home", since: 100, hidden: true },
  ]);
  assert.deepEqual(rows.map(r => [r.person, r.home, r.since]),
                   [["Иван", true, 100], ["Анна", false, null], ["Пётр", false, null]]);
});

test("diffEvents returns only newer ids", () => {
  const ev = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(diffEvents(ev, 1).map(e => e.id), [2, 3]);
});

test("barsFromStats", () => {
  assert.deepEqual(barsFromStats([{ bucket: "2026-10-14", minutes: 90 }]),
                   [{ label: "2026-10-14", value: 90 }]);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `node --test server/tests/js/`
Expected: FAIL (не удаётся импортировать `lib.js`)

- [ ] **Step 3: Реализовать `server/static/lib.js`**

Чистые функции без DOM и `fetch`. `formatDuration` — дни/часы/минуты, незначащие части опускаются. `groupPeople` — фильтрует `hidden`, группирует по `person`, сортирует «дома» вперёд.

- [ ] **Step 4: Прогнать тест**

Run: `node --test server/tests/js/`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add server/static/lib.js server/tests/js/lib.test.mjs
git commit -m "feat(panel): pure helpers with node tests"
```

---

### Task 12: Панель — каркас, стили и главная страница

**Files:**
- Create: `server/static/index.html`, `server/static/style.css`, `server/static/api.js`, `server/static/app.js`, `server/static/views/home.js`

**Interfaces:**
- Consumes: `lib.js` (Task 11), API (Task 8)
- Produces: `views/home.js` экспортирует `render(root, state)`; `api.js` экспортирует `getJSON(path)`, `postJSON(path, body)`, `getState()`; `app.js` — hash-роутер (`#/`, `#/devices`, `#/history`, `#/settings`), polling 10 с, индикатор свежести.

- [ ] **Step 1: Реализовать `index.html` + `style.css`**

`index.html`: `<nav>` с четырьмя ссылками (`#/`, `#/devices`, `#/history`, `#/settings`), `<main id="app">`, `<script type="module" src="/app.js">`. `style.css`: тёмная тема (фон `#12151c`, акценты `#4fd1c5`/`#7c8cff`), адаптивная сетка карточек, состояния `home`/`away`.

- [ ] **Step 2: Реализовать `api.js` и `app.js`**

`api.js` — тонкие обёртки над `fetch` с разбором `{"error"}` в исключение. `app.js` — маршрутизация по `location.hash`, динамический `import()` вьюх, общий `poll()` каждые 10 с, вызывающий `render` активной вьюхи; выставляет `document.title`.

- [ ] **Step 3: Реализовать `views/home.js`**

Карточки людей (имя, «дома/нет», с какого времени через `formatDuration(now - since)`), список устройств человека (диапазон, BSS, сигнал), отдельный блок «Неопознанные» (`trust === "unknown"`), плашка свежести данных из `state.agent`.

- [ ] **Step 4: Ручная проверка**

Run: `cd server && python3 server.py` → открыть `http://127.0.0.1:8787/`; в соседнем терминале отправить тестовый снимок:
```bash
curl -s -X POST http://127.0.0.1:8787/api/ingest -H 'X-Homepanel-Key: CHANGE_ME' \
  -H 'Content-Type: application/json' \
  -d '{"schema":1,"agent":{"hostname":"r","version":"1","ts":1},"clients":[{"mac":"aa:bb:cc:dd:ee:ff","bss":"phy0-ap0","band":"2.4","signal":-45,"ip":"192.168.1.5","hostname":"test"}]}'
```
Expected: карточка неопознанного устройства появляется в течение 10 с; навигация по хэшам работает.

- [ ] **Step 5: Коммит**

```bash
git add server/static/index.html server/static/style.css server/static/api.js server/static/app.js server/static/views/home.js
git commit -m "feat(panel): shell, styles and home view"
```

---

### Task 13: Панель — страница «Устройства»

**Files:**
- Create: `server/static/views/devices.js`

**Interfaces:**
- Consumes: `api.js`, `lib.js`
- Produces: `render(root, state)` для `#/devices`; отправляет `POST /api/devices`.

- [ ] **Step 1: Реализовать `views/devices.js`**

Таблица всех устройств (MAC, имя, человек, тип, доверие `own/guest/unknown`, скрыто, состояние, IP, hostname, BSS, сигнал). Инлайновая правка полей → `postJSON("/api/devices", {...})`; селект «Объединить с…» (по списку MAC) → `{mac, mergeInto}`; кнопка «Скрыть». Подсветка неопознанных.

- [ ] **Step 2: Ручная проверка**

Run: сервер запущен; открыть `#/devices`
Expected: правка имени/человека сохраняется после перезагрузки страницы; объединение убирает исходный MAC; «Скрыть» убирает устройство с главной.

- [ ] **Step 3: Коммит**

```bash
git add server/static/views/devices.js
git commit -m "feat(panel): devices management view"
```

---

### Task 14: Панель — страница «История» (графики)

**Files:**
- Create: `server/static/charts.js`, `server/static/views/history.js`

**Interfaces:**
- Consumes: `api.js`, `lib.js`, `stats.compute_stats` (Task 7)
- Produces: `charts.js` экспортирует `barChart(root, bars: {label,value}[], opts) -> void` (SVG); `views/history.js` экспортирует `render(root, state)` для `#/history`.

- [ ] **Step 1: Реализовать `charts.js` и `views/history.js`**

`barChart` — инлайновый SVG, столбцы с подписями, ось значений в часах. `views/history.js` — селекторы периода (день/неделя) и человека, запрос `/api/stats?group=day|week&from=&to=`, преобразование через `barsFromStats`, вывод графика и суммарного времени.

- [ ] **Step 2: Ручная проверка**

Run: сервер запущен; сгенерировать данные (несколько снимков + ожидание grace), открыть `#/history`
Expected: столбцы соответствуют минутам онлайн; смена периода и человека перерисовывает график.

- [ ] **Step 3: Коммит**

```bash
git add server/static/charts.js server/static/views/history.js
git commit -m "feat(panel): history view with SVG charts"
```

---

### Task 15: Панель — «Настройки» и уведомления

**Files:**
- Create: `server/static/views/settings.js`

**Interfaces:**
- Consumes: `api.js`, `lib.js`, `Notification` API
- Produces: `render(root, state)` для `#/settings`; хранение `homepanel.lastEventId` в `localStorage`.

- [ ] **Step 1: Реализовать `views/settings.js`**

Секрет и пример `curl`/UCI-конфига для агента, подсказки по LuCI-странице роутера. Блок уведомлений: кнопка запроса разрешения (`Notification.requestPermission()` по жесту), чекбоксы людей/устройств; в `poll`-цикле — `getEvents(lastId)` → `diffEvents` → `new Notification(...)` (при отказе — всплывашки в DOM). Обновление `localStorage["homepanel.lastEventId"]`.

- [ ] **Step 2: Ручная проверка**

Run: сервер запущен, открыт по `http://127.0.0.1:8787/`; нажать «Включить уведомления»
Expected: разрешение запрашивается; при отправке снимка с новым MAC появляется уведомление «пришёл» (по HTTPS-домену NPM); события не дублируются между poll-циклами.

- [ ] **Step 3: Коммит**

```bash
git add server/static/views/settings.js
git commit -m "feat(panel): settings view and browser notifications"
```

---

## Self-Review

- **Spec coverage:** §5 контракт → Task 4/8; §6 агент → план роутера; §7 LuCI → план роутера; §8 сервер → Task 1–10; §9 модель данных → Task 2–3; §10 присутствие → Task 5; §11 API → Task 8; §12 панель → Task 11–15; §13 уведомления → Task 15; §14 конфиг → Task 1; §15 деплой (сервер) → Task 10; §16 тесты → TDD в каждой задаче. Разделы, относящиеся к роутеру (§4, §6, §7, §15-роутер), покрывает `2026-10-18-homepanel-router.md`.
- **Step scan:** каждый шаг даёт одно однозначное действие; тела функций не переписаны, вместо них — сигнатуры и проверяемые свойства.
- **Type consistency:** `Store`, `PresenceEngine`, `Snapshot/Client`, `App`, `compute_stats`, `record_minutes`/`rollup_daily`/`prune`, `day_key`/`week_key` используются с одинаковыми именами во всех задачах.
- **Review Focus:** пять классов покрыты — обход каталога (Task 8), большой body (Task 8), сдвиг часов (Task 5), дубль MAC по BSS (Task 5), пустой/битый ingest (Task 4 и Task 5).
- **Proportion:** план ссылается на спеку §-ами и фиксирует только решения (имена, сигнатуры, значения), а не текст программы.
