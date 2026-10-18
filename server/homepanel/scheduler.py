"""Фоновый планировщик: истечение grace, запись минут, дневной роллап и очистка.

`run_once` вызывается из потока, поднятого `start()`, и в тестах — напрямую.
Порядок внутри тика: сначала истечение grace (ушедшие не должны попасть в
текущую минуту), затем запись минуты присутствия для тех, кто ещё дома.
"""

from __future__ import annotations

import logging
import threading
import time

from . import aggregator

log = logging.getLogger(__name__)


class Scheduler:
    def __init__(
        self,
        store,
        engine,
        *,
        minute_days: int,
        daily_days: int,
        tick_seconds: int = 15,
        clock=time.time,
    ):
        self.store = store
        self.engine = engine
        self.minute_days = minute_days
        self.daily_days = daily_days
        self.tick_seconds = tick_seconds
        self._clock = clock
        self._last_day: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self, now: int) -> dict:
        expired = len(self.engine.expire(now))
        minutes = aggregator.record_minutes(self.store, now)

        day = aggregator.day_key(now)
        rolled_day: str | None = None
        previous = self._last_day
        if previous is None:
            # Первый тик после старта процесса: закрываем вчерашние сутки,
            # даже если сервер был выключен в полночь.
            previous = aggregator.day_key(now - 86400)
        if day != previous:
            aggregator.rollup_daily(self.store, previous)
            aggregator.prune(self.store, now, self.minute_days, self.daily_days)
            rolled_day = previous
        self._last_day = day

        return {"expired": expired, "minutes": minutes, "rolled_day": rolled_day}

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="homepanel-scheduler", daemon=True
        )
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once(int(self._clock()))
            except Exception:  # планировщик не должен умирать из-за одного тика
                log.exception("scheduler tick failed")
            self._stop.wait(self.tick_seconds)

    def stop(self) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=self.tick_seconds + 1)
