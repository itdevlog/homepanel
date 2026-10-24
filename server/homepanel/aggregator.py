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


def prune(store: Store, now: int, minute_days: int, daily_days: int, signal_days: int = 7) -> dict:
    minutes = store.prune_minutes(now - minute_days * 86400)
    days = store.prune_daily(day_key(now - daily_days * 86400))
    signals = store.prune_signals(now - signal_days * 86400)
    return {"minutes": minutes, "days": days, "signals": signals}


def rollup_pending(store: Store, now: int) -> list[str]:
    """Сводит в daily_presence все закрытые сутки, по которым есть минуты.

    Без этого простой сервера в несколько суток оставлял бы дыру в истории:
    пропущенные мимо смены суток дни никогда не попадали в роллап и исчезали
    после очистки minute_presence (ревью I2).
    """
    today = day_key(now)
    rolled = store.rolled_days()
    done: list[str] = []
    for day in store.days_with_minutes():
        if day >= today or day in rolled:
            continue
        rollup_daily(store, day)
        done.append(day)
    return done
