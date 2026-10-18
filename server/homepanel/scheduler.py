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
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def run_once(self, now: int) -> dict:
        expired = len(self.engine.expire(now))
        minutes = aggregator.record_minutes(self.store, now)

        rolled = aggregator.rollup_pending(self.store, now)
        aggregator.prune(self.store, now, self.minute_days, self.daily_days)

        return {
            "expired": expired,
            "minutes": minutes,
            "rolled_day": rolled[-1] if rolled else None,
        }

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
