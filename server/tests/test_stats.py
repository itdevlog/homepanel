import os
import tempfile
import time
import unittest

from homepanel import aggregator, stats
from homepanel.store import Store


class StatsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.sqlite3"))

    def tearDown(self):
        self.store.close()
        self.dir.cleanup()

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

    def test_day_stats_survive_minute_prune_via_rollup(self):
        noon = int(time.mktime(time.strptime("2026-10-14 12:00", "%Y-%m-%d %H:%M")))
        self.store.mark_minute("aa:aa:aa:aa:aa:aa", noon)
        self.store.mark_minute("aa:aa:aa:aa:aa:aa", noon + 60)
        aggregator.rollup_daily(self.store, "2026-10-14")
        self.store.prune_minutes(noon + 3600)  # минутные строки удалены по retention
        rows = stats.compute_stats(self.store, group="day", from_day="2026-10-14", to_day="2026-10-14")
        self.assertEqual(rows, [{"bucket": "2026-10-14", "minutes": 2}])
        wk = stats.compute_stats(self.store, group="week", from_day="2026-10-14", to_day="2026-10-14")
        self.assertEqual(wk, [{"bucket": stats.week_key("2026-10-14"), "minutes": 2}])

    def test_mac_filter(self):
        noon = int(time.mktime(time.strptime("2026-10-14 12:00", "%Y-%m-%d %H:%M")))
        self.store.mark_minute("aa:aa:aa:aa:aa:aa", noon)
        self.store.mark_minute("bb:bb:bb:bb:bb:bb", noon)
        rows = stats.compute_stats(self.store, group="hour", from_day="2026-10-14",
                                   to_day="2026-10-14", macs=["aa:aa:aa:aa:aa:aa"])
        self.assertEqual(sum(r["minutes"] for r in rows), 1)


if __name__ == "__main__":
    unittest.main()
