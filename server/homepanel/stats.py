"""Агрегация статистики для графиков (спека §11, `/api/stats`).

Бакеты: `hour` — по минутам из `minute_presence`, `day`/`week` — по дневному
роллапу `daily_presence`. Разбиение по локальной таймзоне сервера.
"""

from __future__ import annotations

import datetime
import time

from .store import Store

VALID_GROUPS = ("hour", "day", "week")


def _midnight(day: str) -> int:
    """Epoch-секунды локальной полуночи дня `YYYY-MM-DD`."""
    d = datetime.date.fromisoformat(day)
    return int(time.mktime(d.timetuple()))


def day_bounds(from_day: str, to_day: str) -> tuple[int, int]:
    """Полуинтервал `[from, to)` в epoch-секундах по локальным суткам."""
    start = _midnight(from_day)
    end = _midnight((datetime.date.fromisoformat(to_day) + datetime.timedelta(days=1)).isoformat())
    return start, end


def week_key(day: str) -> str:
    """ISO-неделя дня: `YYYY-Www`."""
    iso = datetime.date.fromisoformat(day).isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def compute_stats(
    store: Store,
    *,
    group: str,
    from_day: str,
    to_day: str,
    macs: list[str] | None = None,
) -> list[dict]:
    if group not in VALID_GROUPS:
        raise ValueError(f"unknown group: {group!r}")

    start, end = day_bounds(from_day, to_day)

    if group == "hour":
        rows = store.minutes_by_hour(start, end, macs)
        buckets = {
            time.strftime("%Y-%m-%dT%H", time.localtime(row["hour_ts"])): row["minutes"]
            for row in rows
        }
    else:
        daily = store.minutes_by_day(start, end, macs)
        if group == "day":
            buckets = {row["day"]: row["minutes"] for row in daily}
        else:
            buckets = {}
            for row in daily:
                key = week_key(row["day"])
                buckets[key] = buckets.get(key, 0) + row["minutes"]

    return [{"bucket": key, "minutes": buckets[key]} for key in sorted(buckets)]
