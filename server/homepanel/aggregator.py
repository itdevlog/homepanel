"""Агрегаты присутствия: минуты онлайн, дневной роллап, очистка (спека §8).

`record_minutes` вызывается планировщиком каждую минуту; `rollup_daily` и
`prune` — при переходе на новые сутки.
"""

from __future__ import annotations

import time

from .store import Store


def day_key(ts: int) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def record_minutes(store: Store, now: int) -> int:
    minute_ts = now - now % 60
    count = 0
    for presence in store.all_presence():
        if presence["state"] != "home":
            continue
        store.mark_minute(presence["mac"], minute_ts)
        count += 1
    return count


def rollup_daily(store: Store, day: str) -> int:
    minutes = store.minutes_for_day(day)
    for mac, value in minutes.items():
        store.upsert_daily(mac, day, value)
    return len(minutes)


def prune(store: Store, now: int, minute_days: int, daily_days: int) -> dict:
    minutes = store.prune_minutes(now - minute_days * 86400)
    days = store.prune_daily(day_key(now - daily_days * 86400))
    return {"minutes": minutes, "days": days}
