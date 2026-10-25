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

DEVICE_FIELDS = ("name", "person", "kind", "trust", "hidden", "notes")
TRUST_VALUES = ("own", "guest", "unknown")
KIND_VALUES = ("phone", "laptop", "tv", "iot", "other")
PRESENCE_FIELDS = (
    "state",
    "last_seen",
    "since",
    "bss",
    "band",
    "signal",
    "ip",
    "hostname",
)
EVENT_FIELDS = ("bss", "band", "ip")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    mac        TEXT PRIMARY KEY,
    name       TEXT,
    person     TEXT,
    kind       TEXT,
    trust      TEXT NOT NULL DEFAULT 'unknown',
    hidden     INTEGER NOT NULL DEFAULT 0,
    notes      TEXT,
    created_at INTEGER,
    updated_at INTEGER
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
    updated_at INTEGER
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

-- Правила авто-разметки: шаблон по hostname/IP/MAC и поля для новых устройств.
CREATE TABLE IF NOT EXISTS label_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern    TEXT NOT NULL,
    person     TEXT,
    kind       TEXT,
    trust      TEXT,
    created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_signal_ts ON signal_samples(bucket_ts);
CREATE INDEX IF NOT EXISTS idx_events_mac_ts ON events(mac, ts);
CREATE INDEX IF NOT EXISTS idx_minute_mac_ts ON minute_presence(mac, minute_ts);
CREATE INDEX IF NOT EXISTS idx_minute_ts ON minute_presence(minute_ts);
CREATE INDEX IF NOT EXISTS idx_presence_state ON presence(state);
CREATE INDEX IF NOT EXISTS idx_changes_ts ON changes(ts);
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
            self._conn.execute("DELETE FROM presence WHERE mac = ?", (src_mac,))
            self._conn.execute("DELETE FROM devices WHERE mac = ?", (src_mac,))
            merged = self._conn.execute(
                "SELECT * FROM devices WHERE mac = ?", (dst_mac,)
            ).fetchone()
        return _device_row_to_dict(merged)

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
        trust: str | None = None,
    ) -> dict:
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "INSERT INTO label_rules (pattern, person, kind, trust, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (pattern, person, kind, trust, int(time.time())),
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
                    "INSERT INTO label_rules (pattern, person, kind, trust, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        rule.get("pattern"),
                        rule.get("person"),
                        rule.get("kind"),
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
