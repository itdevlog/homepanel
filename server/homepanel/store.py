"""Хранилище SQLite: устройства, присутствие, события и агрегаты.

Схема — спека §9. Доступ к соединению сериализован `self._lock`
(`check_same_thread=False` позволяет использовать один `Store` из нескольких
потоков сервера).
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time

DEVICE_FIELDS = ("name", "person", "kind", "role", "room", "trust", "hidden", "notes")
TRUST_VALUES = ("own", "guest", "unknown")
KIND_VALUES = ("phone", "laptop", "tablet", "tv", "iot", "other")
ROLE_VALUES = ("person", "infra", "guest")
PRESENCE_FIELDS = (
    "state",
    "last_seen",
    "since",
    "bss",
    "band",
    "signal",
    "ip",
    "hostname",
    "link",
)
EVENT_FIELDS = ("bss", "band", "ip")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    mac        TEXT PRIMARY KEY,
    name       TEXT,
    person     TEXT,
    kind       TEXT,
    role       TEXT,
    room       TEXT,
    trust      TEXT NOT NULL DEFAULT 'unknown',
    hidden     INTEGER NOT NULL DEFAULT 0,
    notes      TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    link       TEXT
);

CREATE TABLE IF NOT EXISTS presence (
    mac        TEXT PRIMARY KEY,
    state      TEXT NOT NULL DEFAULT 'away',
    last_seen  INTEGER,
    since      INTEGER,
    bss        TEXT,
    band       TEXT,
    signal     INTEGER,
    ip         TEXT,
    hostname   TEXT,
    updated_at INTEGER,
    link       TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    mac  TEXT NOT NULL,
    type TEXT NOT NULL,
    ts   INTEGER NOT NULL,
    bss  TEXT,
    band TEXT,
    ip   TEXT
);

CREATE TABLE IF NOT EXISTS minute_presence (
    mac       TEXT NOT NULL,
    minute_ts INTEGER NOT NULL,
    PRIMARY KEY (mac, minute_ts)
);

CREATE TABLE IF NOT EXISTS daily_presence (
    mac     TEXT NOT NULL,
    day     TEXT NOT NULL,
    minutes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mac, day)
);

-- Сигнал Wi-Fi хранится не чаще одного раза в 5 минут на устройство:
-- этого хватает для суточного графика, а таблица не растёт без предела.
CREATE TABLE IF NOT EXISTS signal_samples (
    mac       TEXT NOT NULL,
    bucket_ts INTEGER NOT NULL,
    signal    INTEGER NOT NULL,
    PRIMARY KEY (mac, bucket_ts)
);

-- Отметки связи агента (не чаще раза в минуту) — для графика аптайма.
CREATE TABLE IF NOT EXISTS agent_seen (
    minute_ts INTEGER PRIMARY KEY
);

-- Журнал изменений разметки: кто и когда менял устройства и правила.
CREATE TABLE IF NOT EXISTS changes (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    action TEXT NOT NULL,
    mac    TEXT,
    detail TEXT
);

-- Какие MAC были объединены в одно устройство (для разъединения).
CREATE TABLE IF NOT EXISTS device_aliases (
    mac        TEXT PRIMARY KEY,
    target_mac TEXT NOT NULL,
    created_at INTEGER
);

-- Правила авто-разметки: шаблон по hostname/IP/MAC и поля для новых устройств.
CREATE TABLE IF NOT EXISTS label_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern    TEXT NOT NULL,
    person     TEXT,
    kind       TEXT,
    role       TEXT,
    room       TEXT,
    trust      TEXT,
    created_at INTEGER
);

-- Пауза интернета по MAC: сервер — источник истины, агент применяет.
CREATE TABLE IF NOT EXISTS device_control (
    mac        TEXT PRIMARY KEY,
    paused     INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
);

-- Очередь команд агенту (kick/restart): at-most-once, с подтверждением.
CREATE TABLE IF NOT EXISTS agent_commands (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    type    TEXT NOT NULL,
    mac     TEXT,
    status  TEXT NOT NULL DEFAULT 'pending',
    sent_ts INTEGER,
    ack_ts  INTEGER,
    error   TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_signal_ts ON signal_samples(bucket_ts);
CREATE INDEX IF NOT EXISTS idx_events_mac_ts ON events(mac, ts);
CREATE INDEX IF NOT EXISTS idx_minute_mac_ts ON minute_presence(mac, minute_ts);
CREATE INDEX IF NOT EXISTS idx_minute_ts ON minute_presence(minute_ts);
CREATE INDEX IF NOT EXISTS idx_presence_state ON presence(state);
CREATE INDEX IF NOT EXISTS idx_changes_ts ON changes(ts);

CREATE TABLE IF NOT EXISTS router_samples (
    ts INTEGER PRIMARY KEY, uptime INTEGER, load1 REAL, load5 REAL, load15 REAL,
    mem_total INTEGER, mem_free INTEGER, wan_up INTEGER, wan_ip TEXT
);
CREATE TABLE IF NOT EXISTS device_traffic (
    mac TEXT PRIMARY KEY, rx_bytes INTEGER, tx_bytes INTEGER, ts INTEGER
);
CREATE TABLE IF NOT EXISTS traffic_samples (
    mac TEXT NOT NULL, bucket_ts INTEGER NOT NULL,
    rx_bytes INTEGER NOT NULL DEFAULT 0, tx_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mac, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_traffic_ts ON traffic_samples(bucket_ts);
"""


def _device_row_to_dict(row: sqlite3.Row) -> dict:
    data = dict(row)
    data["hidden"] = bool(data["hidden"])
    return data


class Store:
    def __init__(self, path: str):
        self.path = path
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        self._ensure_column("devices", "link", "link TEXT")
        self._ensure_column("presence", "link", "link TEXT")
        self._ensure_column("devices", "role", "role TEXT")
        self._ensure_column("devices", "room", "room TEXT")
        self._ensure_column("label_rules", "role", "role TEXT")
        self._ensure_column("label_rules", "room", "room TEXT")

    def _ensure_column(self, table: str, name: str, ddl: str) -> None:
        """Идемпотентно добавить колонку в существующую базу."""
        with self._lock:
            columns = {
                row[1] for row in self._conn.execute(f"PRAGMA table_info({table})")
            }
            if name not in columns:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")
                self._conn.commit()

    def set_links(self, mac: str, link: str) -> None:
        """Сохранить тип подключения клиента в devices и presence."""
        mac = mac.lower()
        link = "wired" if link == "wired" else "wifi"
        now = int(time.time())
        with self._lock:
            self._conn.execute(
                "INSERT INTO devices (mac, link) VALUES (?, ?) "
                "ON CONFLICT(mac) DO UPDATE SET link = excluded.link",
                (mac, link),
            )
            self._conn.execute(
                "INSERT INTO presence (mac, link, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(mac) DO UPDATE SET link = excluded.link",
                (mac, link, now),
            )
            self._conn.commit()

    def get_links(self) -> dict[str, str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT mac, link FROM devices WHERE link IS NOT NULL"
            ).fetchall()
        return {row["mac"]: row["link"] for row in rows}

    def set_control(self, mac: str, paused: bool, now: int) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO device_control (mac, paused, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(mac) DO UPDATE SET paused = excluded.paused, "
                "updated_at = excluded.updated_at",
                (mac.lower(), 1 if paused else 0, int(now)),
            )
            self._conn.commit()

    def paused_macs(self) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT mac FROM device_control WHERE paused = 1 ORDER BY mac"
            ).fetchall()
        return [row["mac"] for row in rows]

    def is_paused(self, mac: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT paused FROM device_control WHERE mac = ?", (mac.lower(),)
            ).fetchone()
        return bool(row and row["paused"])

    def create_command(self, kind: str, mac: str | None, now: int) -> dict:
        normalized = (mac or "").lower() or None
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM agent_commands WHERE type = ? "
                "AND coalesce(mac, '') = coalesce(?, '') "
                "AND status IN ('pending', 'sent') ORDER BY id DESC LIMIT 1",
                (kind, normalized),
            ).fetchone()
            if row is not None:
                return dict(row)
            cursor = self._conn.execute(
                "INSERT INTO agent_commands (ts, type, mac, status) "
                "VALUES (?, ?, ?, 'pending')",
                (int(now), kind, normalized),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM agent_commands WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        return dict(row)

    def pending_commands(self, now: int, limit: int = 20) -> list[dict]:
        limit = max(1, min(20, int(limit)))
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM agent_commands WHERE status = 'pending' "
                "ORDER BY id LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_commands_sent(self, ids: list[int], now: int) -> int:
        if not ids:
            return 0
        marks = ",".join("?" for _ in ids)
        with self._lock:
            cursor = self._conn.execute(
                "UPDATE agent_commands SET status = 'sent', sent_ts = ? "
                f"WHERE status = 'pending' AND id IN ({marks})",
                [int(now), *ids],
            )
            self._conn.commit()
            return cursor.rowcount

    def apply_acks(self, acks: list[dict], now: int) -> int:
        changed = 0
        with self._lock:
            for ack in acks or []:
                if not isinstance(ack, dict):
                    continue
                try:
                    command_id = int(ack.get("id"))
                except (TypeError, ValueError):
                    continue
                ok = ack.get("ok") is True
                error = ack.get("error")
                if not isinstance(error, str):
                    error = None
                cursor = self._conn.execute(
                    "UPDATE agent_commands SET status = ?, ack_ts = ?, error = ? "
                    "WHERE id = ? AND status IN ('pending', 'sent')",
                    ("done" if ok else "error", int(now), error, command_id),
                )
                changed += cursor.rowcount
            self._conn.commit()
        return changed

    def expire_commands(self, now: int) -> int:
        now = int(now)
        with self._lock:
            cursor = self._conn.execute(
                "UPDATE agent_commands SET status = 'error', error = 'timeout', ack_ts = ? "
                "WHERE status IN ('pending', 'sent') AND "
                "((type = 'kick' AND ts < ?) OR (type <> 'kick' AND ts < ?))",
                (now, now - 60, now - 90),
            )
            self._conn.commit()
            return cursor.rowcount

    def recent_commands(self, limit: int = 10) -> list[dict]:
        limit = max(1, min(50, int(limit)))
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM agent_commands ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(row) for row in rows]

    def prune_commands(self, before_ts: int) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM agent_commands WHERE status IN ('done', 'error') AND ts < ?",
                (int(before_ts),),
            )
            self._conn.commit()
            return cursor.rowcount

    def record_router(self, now: int, router: dict) -> bool:
        now = int(now)
        with self._lock:
            row = self._conn.execute("SELECT MAX(ts) AS ts FROM router_samples").fetchone()
            latest = row["ts"] if row else None
            if latest is not None and now - int(latest) < 20:
                return False
            self._conn.execute(
                "INSERT OR REPLACE INTO router_samples "
                "(ts, uptime, load1, load5, load15, mem_total, mem_free, wan_up, wan_ip) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    now,
                    router.get("uptime"),
                    router.get("load1"),
                    router.get("load5"),
                    router.get("load15"),
                    router.get("mem_total"),
                    router.get("mem_free"),
                    1 if router.get("wan_up") else 0,
                    router.get("wan_ip"),
                ),
            )
            self._conn.commit()
            return True

    def router_latest(self) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM router_samples ORDER BY ts DESC LIMIT 1"
            ).fetchone()
        if row is None:
            return None
        data = dict(row)
        data["wan_up"] = bool(data.get("wan_up"))
        return data

    def router_series(self, from_ts: int, to_ts: int, group: str = "hour") -> list[dict]:
        fmt = "%Y-%m-%d" if group == "day" else "%Y-%m-%dT%H"
        with self._lock:
            rows = self._conn.execute(
                "SELECT strftime(?, ts, 'unixepoch', 'localtime') AS bucket, "
                "AVG(load1) AS load1, AVG(mem_total - mem_free) AS mem_used, "
                "MAX(wan_up) AS wan_up "
                "FROM router_samples WHERE ts >= ? AND ts < ? "
                "GROUP BY bucket ORDER BY bucket",
                (fmt, int(from_ts), int(to_ts)),
            ).fetchall()
        return [
            {
                "ts": row["bucket"],
                "load1": round(float(row["load1"] or 0), 2),
                "mem_used": int(row["mem_used"] or 0),
                "wan_up": bool(row["wan_up"]),
            }
            for row in rows
        ]

    def record_traffic(self, now: int, samples) -> int:
        now = int(now)
        bucket = now // 300 * 300
        written = 0
        with self._lock:
            for mac, rx, tx in samples:
                if rx is None or tx is None:
                    continue
                mac = str(mac).lower()
                rx, tx = int(rx), int(tx)
                prev = self._conn.execute(
                    "SELECT rx_bytes, tx_bytes FROM device_traffic WHERE mac = ?",
                    (mac,),
                ).fetchone()
                if prev is None:
                    d_rx = d_tx = 0
                else:
                    d_rx = rx - prev["rx_bytes"] if rx >= prev["rx_bytes"] else rx
                    d_tx = tx - prev["tx_bytes"] if tx >= prev["tx_bytes"] else tx
                self._conn.execute(
                    "INSERT INTO device_traffic (mac, rx_bytes, tx_bytes, ts) "
                    "VALUES (?, ?, ?, ?) ON CONFLICT(mac) DO UPDATE SET "
                    "rx_bytes=excluded.rx_bytes, tx_bytes=excluded.tx_bytes, ts=excluded.ts",
                    (mac, rx, tx, now),
                )
                self._conn.execute(
                    "INSERT INTO traffic_samples (mac, bucket_ts, rx_bytes, tx_bytes) "
                    "VALUES (?, ?, ?, ?) ON CONFLICT(mac, bucket_ts) DO UPDATE SET "
                    "rx_bytes=traffic_samples.rx_bytes+excluded.rx_bytes, "
                    "tx_bytes=traffic_samples.tx_bytes+excluded.tx_bytes",
                    (mac, bucket, d_rx, d_tx),
                )
                written += 1
            self._conn.commit()
        return written

    def last_traffic(self) -> dict:
        with self._lock:
            rows = self._conn.execute(
                "SELECT mac, rx_bytes, tx_bytes, ts FROM device_traffic"
            ).fetchall()
        return {
            row["mac"]: {
                "rx_bytes": row["rx_bytes"],
                "tx_bytes": row["tx_bytes"],
                "ts": row["ts"],
            }
            for row in rows
        }

    def traffic_series(self, mac: str, from_ts: int, to_ts: int) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT bucket_ts, rx_bytes, tx_bytes FROM traffic_samples "
                "WHERE mac = ? AND bucket_ts >= ? AND bucket_ts < ? "
                "ORDER BY bucket_ts",
                (str(mac).lower(), int(from_ts), int(to_ts)),
            ).fetchall()
        return [
            {
                "ts": row["bucket_ts"],
                "rx_bytes": row["rx_bytes"],
                "tx_bytes": row["tx_bytes"],
            }
            for row in rows
        ]

    def prune_router(self, before_ts: int) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM router_samples WHERE ts < ?", (int(before_ts),)
            )
            self._conn.commit()
            return cursor.rowcount

    def prune_traffic(self, before_ts: int) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM traffic_samples WHERE bucket_ts < ?", (int(before_ts),)
            )
            self._conn.commit()
            return cursor.rowcount

    def snapshot_bytes(self) -> bytes:
        """Консистентная копия базы (SQLite backup API) для скачивания."""
        import tempfile

        handle, tmp_path = tempfile.mkstemp(suffix=".sqlite3")
        os.close(handle)
        try:
            with self._lock:
                dest = sqlite3.connect(tmp_path)
                try:
                    self._conn.backup(dest)
                finally:
                    dest.close()
            with open(tmp_path, "rb") as file:
                return file.read()
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    def replace_from_bytes(self, data: bytes) -> dict:
        """Заменить базу файлом из резервной копии, сохранив старую рядом."""
        if not data.startswith(b"SQLite format 3\x00"):
            raise ValueError("Файл не похож на базу SQLite")

        tmp_path = self.path + ".incoming"
        with open(tmp_path, "wb") as file:
            file.write(data)
        try:
            check = sqlite3.connect(tmp_path)
            try:
                row = check.execute("PRAGMA integrity_check").fetchone()
                if not row or row[0] != "ok":
                    raise ValueError("Проверка целостности базы не пройдена")
                tables = {
                    item[0]
                    for item in check.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    )
                }
            finally:
                check.close()
            required = {"devices", "presence", "events", "minute_presence", "daily_presence"}
            if not required.issubset(tables):
                raise ValueError("В файле нет таблиц Home Panel")
        except Exception:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise

        backup_path = self.path + ".before-import"
        with self._lock:
            self._conn.close()
            for suffix in ("-wal", "-shm"):
                try:
                    os.remove(self.path + suffix)
                except OSError:
                    pass
            if os.path.exists(self.path):
                os.replace(self.path, backup_path)
            os.replace(tmp_path, self.path)
            try:
                self._conn = sqlite3.connect(self.path, check_same_thread=False)
                self._conn.row_factory = sqlite3.Row
                self._conn.execute("PRAGMA journal_mode=WAL")
                self._conn.executescript(_SCHEMA)
                self._conn.commit()
                count = self._conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
            except Exception:
                try:
                    self._conn.close()
                except Exception:
                    pass
                if os.path.exists(backup_path):
                    os.replace(backup_path, self.path)
                self._conn = sqlite3.connect(self.path, check_same_thread=False)
                self._conn.row_factory = sqlite3.Row
                self._conn.execute("PRAGMA journal_mode=WAL")
                raise
        return {"devices": int(count)}

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- устройства ------------------------------------------------------

    def get_devices(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM devices ORDER BY mac"
            ).fetchall()
        return [_device_row_to_dict(r) for r in rows]

    def get_device(self, mac: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM devices WHERE mac = ?", (mac.lower(),)
            ).fetchone()
        return _device_row_to_dict(row) if row else None

    def upsert_device(self, mac: str, **fields) -> dict:
        mac = mac.lower()
        now = int(time.time())
        values = {k: v for k, v in fields.items() if k in DEVICE_FIELDS and v is not None}
        if "hidden" in values:
            values["hidden"] = int(bool(values["hidden"]))

        with self._lock:
            existing = self._conn.execute(
                "SELECT mac FROM devices WHERE mac = ?", (mac,)
            ).fetchone()
            if existing is None:
                columns = ["mac", "created_at", "updated_at", *values.keys()]
                params = [mac, now, now, *values.values()]
                placeholders = ", ".join("?" for _ in columns)
                self._conn.execute(
                    f"INSERT INTO devices ({', '.join(columns)}) VALUES ({placeholders})",
                    params,
                )
            elif values:
                assignments = ", ".join(f"{k} = ?" for k in values)
                self._conn.execute(
                    f"UPDATE devices SET {assignments}, updated_at = ? WHERE mac = ?",
                    [*values.values(), now, mac],
                )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM devices WHERE mac = ?", (mac,)
            ).fetchone()
        return _device_row_to_dict(row)

    def log_change(
        self, ts: int, action: str, mac: str | None = None, detail: str | None = None
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO changes (ts, action, mac, detail) VALUES (?, ?, ?, ?)",
                (int(ts), action, mac, detail),
            )
            self._conn.commit()

    def get_changes(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, ts, action, mac, detail FROM changes ORDER BY id DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
        return [dict(row) for row in rows]

    def prune_changes(self, before_ts: int) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM changes WHERE ts < ?", (int(before_ts),)
            )
            self._conn.commit()
            return cursor.rowcount

    def merge_devices(self, src_mac: str, dst_mac: str) -> dict:
        src_mac, dst_mac = src_mac.lower(), dst_mac.lower()
        if src_mac == dst_mac:
            raise ValueError("merge_devices: src and dst must differ")
        src = self.get_device(src_mac)
        now = int(time.time())

        # Перенос и удаление — одной транзакцией, чтобы при сбое состояние не
        # осталось частично применённым (ревью I5).
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT * FROM devices WHERE mac = ?", (dst_mac,)
            ).fetchone()
            if row is None:
                self._conn.execute(
                    "INSERT INTO devices (mac, created_at, updated_at) VALUES (?, ?, ?)",
                    (dst_mac, now, now),
                )
                dst: dict = {}
            else:
                dst = _device_row_to_dict(row)

            transferred: dict = {}
            for field in ("name", "person", "kind", "notes"):
                if src and src[field] and not dst.get(field):
                    transferred[field] = src[field]
            if src and src.get("trust") and src["trust"] != "unknown" and dst.get("trust") in (
                None,
                "",
                "unknown",
            ):
                transferred["trust"] = src["trust"]
            if src and src.get("hidden") and not dst.get("hidden"):
                transferred["hidden"] = 1

            if transferred:
                assignments = ", ".join(f"{k} = ?" for k in transferred)
                self._conn.execute(
                    f"UPDATE devices SET {assignments}, updated_at = ? WHERE mac = ?",
                    [*transferred.values(), now, dst_mac],
                )
            # Объединённые MAC запоминаем, чтобы их можно было разъединить;
            # цепочка a→b→c перепривязывается к конечному устройству.
            self._conn.execute(
                "UPDATE device_aliases SET target_mac = ? WHERE target_mac = ?",
                (dst_mac, src_mac),
            )
            self._conn.execute(
                "INSERT INTO device_aliases (mac, target_mac, created_at) VALUES (?, ?, ?) "
                "ON CONFLICT(mac) DO UPDATE SET target_mac = excluded.target_mac, "
                "created_at = excluded.created_at",
                (src_mac, dst_mac, now),
            )
            self._conn.execute("DELETE FROM presence WHERE mac = ?", (src_mac,))
            self._conn.execute("DELETE FROM devices WHERE mac = ?", (src_mac,))
            merged = self._conn.execute(
                "SELECT * FROM devices WHERE mac = ?", (dst_mac,)
            ).fetchone()
        return _device_row_to_dict(merged)

    def aliases_for(self, target_mac: str) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT mac FROM device_aliases WHERE target_mac = ? "
                "ORDER BY created_at, mac",
                (target_mac.lower(),),
            ).fetchall()
        return [row["mac"] for row in rows]

    def all_aliases(self) -> dict[str, list[str]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT mac, target_mac FROM device_aliases ORDER BY created_at, mac"
            ).fetchall()
        result: dict[str, list[str]] = {}
        for row in rows:
            result.setdefault(row["target_mac"], []).append(row["mac"])
        return result

    def unmerge_device(self, mac: str) -> dict | None:
        mac = mac.lower()
        now = int(time.time())
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "DELETE FROM device_aliases WHERE mac = ?", (mac,)
            )
            if cursor.rowcount == 0:
                return None
            self._conn.execute(
                "INSERT OR IGNORE INTO devices (mac, created_at, updated_at) "
                "VALUES (?, ?, ?)",
                (mac, now, now),
            )
        return self.get_device(mac)

    def bulk_update(self, macs: list[str], fields: dict) -> int:
        """Применить разметку к списку MAC; вернуть число затронутых записей."""
        macs = [mac.lower() for mac in macs if mac]
        if not macs:
            return 0
        now = int(time.time())
        values = {k: v for k, v in fields.items() if k in DEVICE_FIELDS and v is not None}
        if "hidden" in values:
            values["hidden"] = int(bool(values["hidden"]))

        updated = 0
        with self._lock, self._conn:
            for mac in macs:
                exists = self._conn.execute(
                    "SELECT 1 FROM devices WHERE mac = ?", (mac,)
                ).fetchone()
                if exists is None:
                    columns = ["mac", "created_at", "updated_at", *values.keys()]
                    params = [mac, now, now, *values.values()]
                    placeholders = ", ".join("?" for _ in columns)
                    self._conn.execute(
                        f"INSERT INTO devices ({', '.join(columns)}) VALUES ({placeholders})",
                        params,
                    )
                    updated += 1
                elif values:
                    assignments = ", ".join(f"{k} = ?" for k in values)
                    self._conn.execute(
                        f"UPDATE devices SET {assignments}, updated_at = ? WHERE mac = ?",
                        [*values.values(), now, mac],
                    )
                    updated += 1
        return updated

    def forget_device(self, mac: str) -> bool:
        """Удалить устройство и всю его историю. True, если что-то было."""
        mac = mac.lower()
        with self._lock, self._conn:
            found = self._conn.execute(
                "SELECT 1 FROM devices WHERE mac = ?", (mac,)
            ).fetchone()
            seen = self._conn.execute(
                "SELECT 1 FROM presence WHERE mac = ?", (mac,)
            ).fetchone()
            for table in (
                "presence",
                "devices",
                "signal_samples",
                "minute_presence",
                "daily_presence",
                "events",
            ):
                self._conn.execute(f"DELETE FROM {table} WHERE mac = ?", (mac,))
        return bool(found or seen)

    # -- правила авто-разметки ------------------------------------------

    def get_rules(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM label_rules ORDER BY id").fetchall()
        return [dict(row) for row in rows]

    def add_rule(
        self,
        pattern: str,
        person: str | None = None,
        kind: str | None = None,
        role: str | None = None,
        room: str | None = None,
        trust: str | None = None,
    ) -> dict:
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "INSERT INTO label_rules (pattern, person, kind, role, room, trust, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (pattern, person, kind, role, room, trust, int(time.time())),
            )
            row = self._conn.execute(
                "SELECT * FROM label_rules WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        return dict(row)

    def delete_rule(self, rule_id: int) -> bool:
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "DELETE FROM label_rules WHERE id = ?", (int(rule_id),)
            )
        return cursor.rowcount > 0

    def replace_rules(self, rules: list[dict]) -> int:
        now = int(time.time())
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM label_rules")
            for rule in rules:
                self._conn.execute(
                    "INSERT INTO label_rules (pattern, person, kind, role, room, trust, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        rule.get("pattern"),
                        rule.get("person"),
                        rule.get("kind"),
                        rule.get("role"),
                        rule.get("room"),
                        rule.get("trust"),
                        now,
                    ),
                )
        return len(rules)

    def macs_in_range(self, from_ts: int, to_ts: int) -> set[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT DISTINCT mac FROM minute_presence "
                "WHERE minute_ts >= ? AND minute_ts < ?",
                (int(from_ts), int(to_ts)),
            ).fetchall()
        return {row["mac"] for row in rows}

    def days_with_minutes(self) -> list[str]:
        """Локальные даты, по которым есть записанные минуты."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT DISTINCT date(minute_ts, 'unixepoch', 'localtime') AS day "
                "FROM minute_presence ORDER BY day"
            ).fetchall()
        return [row["day"] for row in rows]

    def rolled_days(self) -> set[str]:
        """Дни, по которым уже есть роллап в daily_presence."""
        with self._lock:
            rows = self._conn.execute("SELECT DISTINCT day FROM daily_presence").fetchall()
        return {row["day"] for row in rows}

    # -- присутствие -----------------------------------------------------

    def get_presence(self, mac: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM presence WHERE mac = ?", (mac.lower(),)
            ).fetchone()
        return dict(row) if row else None

    def all_presence(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM presence ORDER BY mac").fetchall()
        return [dict(r) for r in rows]

    def set_presence(self, mac: str, **fields) -> None:
        mac = mac.lower()
        values = {k: v for k, v in fields.items() if k in PRESENCE_FIELDS}
        values["updated_at"] = int(fields.get("updated_at") or time.time())

        with self._lock:
            existing = self._conn.execute(
                "SELECT mac FROM presence WHERE mac = ?", (mac,)
            ).fetchone()
            if existing is None:
                columns = ["mac", *values.keys()]
                placeholders = ", ".join("?" for _ in columns)
                self._conn.execute(
                    f"INSERT INTO presence ({', '.join(columns)}) VALUES ({placeholders})",
                    [mac, *values.values()],
                )
            else:
                assignments = ", ".join(f"{k} = ?" for k in values)
                self._conn.execute(
                    f"UPDATE presence SET {assignments} WHERE mac = ?",
                    [*values.values(), mac],
                )
            self._conn.commit()

    # -- события ---------------------------------------------------------

    def add_event(self, mac: str, type: str, ts: int, **fields) -> int:
        values = {k: v for k, v in fields.items() if k in EVENT_FIELDS}
        columns = ["mac", "type", "ts", *values.keys()]
        params = [mac.lower(), type, int(ts), *values.values()]
        placeholders = ", ".join("?" for _ in columns)
        with self._lock:
            cursor = self._conn.execute(
                f"INSERT INTO events ({', '.join(columns)}) VALUES ({placeholders})",
                params,
            )
            self._conn.commit()
            return int(cursor.lastrowid)

    def get_events(self, since_id: int | None = None, limit: int = 200) -> list[dict]:
        with self._lock:
            if since_id is None:
                rows = self._conn.execute(
                    "SELECT * FROM events ORDER BY id DESC LIMIT ?", (int(limit),)
                ).fetchall()
                rows = list(reversed(rows))
            else:
                rows = self._conn.execute(
                    "SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
                    (int(since_id), int(limit)),
                ).fetchall()
        return [dict(r) for r in rows]

    def events_between(
        self, from_ts: int, to_ts: int, macs: list[str] | None = None
    ) -> list[dict]:
        """События за полуинтервал `[from_ts, to_ts)` по возрастанию времени."""
        sql, params = self._mac_filter(
            "SELECT * FROM events WHERE ts >= ? AND ts < ?",
            [int(from_ts), int(to_ts)],
            macs,
        )
        sql += " ORDER BY ts, id"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def event_counts_by_hour(
        self, from_ts: int, to_ts: int, macs: list[str] | None = None
    ) -> list[dict]:
        """Приходы и уходы по часам локальных суток (всегда 24 элемента)."""
        sql, params = self._mac_filter(
            "SELECT CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) AS hour, "
            "type, COUNT(*) AS count FROM events WHERE ts >= ? AND ts < ?",
            [int(from_ts), int(to_ts)],
            macs,
        )
        sql += " GROUP BY hour, type"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        counts = {hour: {"hour": hour, "arrived": 0, "left": 0} for hour in range(24)}
        for row in rows:
            if row["type"] in ("arrived", "left"):
                counts[int(row["hour"])][row["type"]] = int(row["count"])
        return [counts[hour] for hour in range(24)]

    # -- сигнал Wi-Fi ----------------------------------------------------

    def add_signal_sample(self, mac: str, ts: int, signal: int, bucket: int = 300) -> None:
        """Сохранить сигнал, схлопывая точки в пятиминутные бакеты."""
        ts = int(ts)
        bucket_ts = ts - ts % int(bucket)
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO signal_samples (mac, bucket_ts, signal) "
                "VALUES (?, ?, ?)",
                (mac.lower(), bucket_ts, int(signal)),
            )
            self._conn.commit()

    def signal_series(self, mac: str, from_ts: int, to_ts: int) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT bucket_ts, signal FROM signal_samples "
                "WHERE mac = ? AND bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts",
                (mac.lower(), int(from_ts), int(to_ts)),
            ).fetchall()
        return [{"ts": int(r["bucket_ts"]), "signal": int(r["signal"])} for r in rows]

    def prune_signals(self, before_ts: int) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM signal_samples WHERE bucket_ts < ?", (int(before_ts),)
            )
            self._conn.commit()
            return cursor.rowcount

    # -- агрегаты минут --------------------------------------------------

    def mark_minute(self, mac: str, minute_ts: int) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO minute_presence (mac, minute_ts) VALUES (?, ?)",
                (mac.lower(), int(minute_ts)),
            )
            self._conn.commit()

    def mark_agent_seen(self, ts: int) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO agent_seen (minute_ts) VALUES (?)",
                (int(ts) // 60 * 60,),
            )
            self._conn.commit()

    def agent_uptime(self, from_ts: int, to_ts: int) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT date(minute_ts, 'unixepoch', 'localtime') AS day, "
                "COUNT(*) AS minutes FROM agent_seen "
                "WHERE minute_ts >= ? AND minute_ts < ? "
                "GROUP BY day ORDER BY day",
                (int(from_ts), int(to_ts)),
            ).fetchall()
        return [{"date": row["day"], "minutes": int(row["minutes"])} for row in rows]

    def last_agent_seen(self) -> int | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT MAX(minute_ts) AS ts FROM agent_seen"
            ).fetchone()
        return None if row is None or row["ts"] is None else int(row["ts"])

    def prune_agent_seen(self, before_ts: int) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM agent_seen WHERE minute_ts < ?", (int(before_ts),)
            )
            self._conn.commit()
            return cursor.rowcount

    def _mac_filter(self, sql: str, params: list, macs: list[str] | None) -> tuple[str, list]:
        if macs is None:
            return sql, params
        placeholders = ", ".join("?" for _ in macs)
        return f"{sql} AND mac IN ({placeholders})", [*params, *[m.lower() for m in macs]]

    def minutes_by_hour(
        self, from_ts: int, to_ts: int, macs: list[str] | None = None
    ) -> list[dict]:
        sql, params = self._mac_filter(
            "SELECT (minute_ts / 3600) * 3600 AS hour_ts, COUNT(*) AS minutes "
            "FROM minute_presence WHERE minute_ts >= ? AND minute_ts < ?",
            [int(from_ts), int(to_ts)],
            macs,
        )
        sql += " GROUP BY hour_ts ORDER BY hour_ts"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [{"hour_ts": int(r["hour_ts"]), "minutes": int(r["minutes"])} for r in rows]

    def minutes_by_day(
        self, from_ts: int, to_ts: int, macs: list[str] | None = None
    ) -> list[dict]:
        sql, params = self._mac_filter(
            "SELECT minute_ts FROM minute_presence WHERE minute_ts >= ? AND minute_ts < ?",
            [int(from_ts), int(to_ts)],
            macs,
        )
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        counts: dict[str, int] = {}
        for row in rows:
            day = time.strftime("%Y-%m-%d", time.localtime(row["minute_ts"]))
            counts[day] = counts.get(day, 0) + 1
        return [{"day": day, "minutes": counts[day]} for day in sorted(counts)]

    def occupancy_by_hour(
        self, from_ts: int, to_ts: int, macs: list[str] | None = None
    ) -> list[dict]:
        """Сколько разных устройств было в сети в каждый час."""
        sql, params = self._mac_filter(
            "SELECT (minute_ts / 3600) * 3600 AS hour_ts, "
            "COUNT(DISTINCT mac) AS devices FROM minute_presence "
            "WHERE minute_ts >= ? AND minute_ts < ?",
            [int(from_ts), int(to_ts)],
            macs,
        )
        sql += " GROUP BY hour_ts ORDER BY hour_ts"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [{"hour_ts": int(r["hour_ts"]), "devices": int(r["devices"])} for r in rows]

    def minutes_union(
        self, from_ts: int, to_ts: int, macs: list[str] | None = None
    ) -> int:
        """Минуты присутствия без двойного счёта: объединение по устройствам."""
        sql, params = self._mac_filter(
            "SELECT COUNT(DISTINCT minute_ts) AS minutes FROM minute_presence "
            "WHERE minute_ts >= ? AND minute_ts < ?",
            [int(from_ts), int(to_ts)],
            macs,
        )
        with self._lock:
            row = self._conn.execute(sql, params).fetchone()
        return int(row["minutes"]) if row else 0

    def device_hour_matrix(
        self, from_ts: int, to_ts: int, macs: list[str] | None = None
    ) -> list[dict]:
        """Минуты присутствия по каждому устройству и часу."""
        sql, params = self._mac_filter(
            "SELECT mac, (minute_ts / 3600) * 3600 AS hour_ts, COUNT(*) AS minutes "
            "FROM minute_presence WHERE minute_ts >= ? AND minute_ts < ?",
            [int(from_ts), int(to_ts)],
            macs,
        )
        sql += " GROUP BY mac, hour_ts ORDER BY mac, hour_ts"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [
            {"mac": r["mac"], "hour_ts": int(r["hour_ts"]), "minutes": int(r["minutes"])}
            for r in rows
        ]

    def minute_timestamps(
        self, from_ts: int, to_ts: int, macs: list[str] | None = None
    ) -> list[int]:
        """Отметки минут присутствия (объединение по устройствам), по возрастанию."""
        sql, params = self._mac_filter(
            "SELECT DISTINCT minute_ts FROM minute_presence "
            "WHERE minute_ts >= ? AND minute_ts < ?",
            [int(from_ts), int(to_ts)],
            macs,
        )
        sql += " ORDER BY minute_ts"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [int(r["minute_ts"]) for r in rows]

    def devices_created_between(self, from_ts: int, to_ts: int) -> list[int]:
        """Моменты создания записей устройств — для графика «новые устройства»."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT created_at FROM devices "
                "WHERE created_at IS NOT NULL AND created_at >= ? AND created_at <= ? "
                "ORDER BY created_at",
                (int(from_ts), int(to_ts)),
            ).fetchall()
        return [int(r["created_at"]) for r in rows]

    def minutes_for_day(self, day: str, macs: list[str] | None = None) -> dict[str, int]:
        start = int(time.mktime(time.strptime(day, "%Y-%m-%d")))
        sql, params = self._mac_filter(
            "SELECT mac, COUNT(*) AS minutes FROM minute_presence "
            "WHERE minute_ts >= ? AND minute_ts < ?",
            [start, start + 86400],
            macs,
        )
        sql += " GROUP BY mac"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return {r["mac"]: int(r["minutes"]) for r in rows}

    def upsert_daily(self, mac: str, day: str, minutes: int) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO daily_presence (mac, day, minutes) VALUES (?, ?, ?) "
                "ON CONFLICT(mac, day) DO UPDATE SET minutes = excluded.minutes",
                (mac.lower(), day, int(minutes)),
            )
            self._conn.commit()

    def daily_totals(
        self, from_day: str, to_day: str, macs: list[str] | None = None
    ) -> dict[str, int]:
        sql, params = self._mac_filter(
            "SELECT day, SUM(minutes) AS minutes FROM daily_presence "
            "WHERE day >= ? AND day <= ?",
            [from_day, to_day],
            macs,
        )
        sql += " GROUP BY day ORDER BY day"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return {r["day"]: int(r["minutes"]) for r in rows}

    def prune_events(self, before_ts: int) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM events WHERE ts < ?", (int(before_ts),)
            )
            self._conn.commit()
            return cursor.rowcount

    def prune_minutes(self, before_ts: int) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM minute_presence WHERE minute_ts < ?", (int(before_ts),)
            )
            self._conn.commit()
            return cursor.rowcount

    def prune_daily(self, before_day: str) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM daily_presence WHERE day < ?", (before_day,)
            )
            self._conn.commit()
            return cursor.rowcount
