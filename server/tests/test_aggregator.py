import os
import tempfile
import unittest

from homepanel.store import Store
from homepanel import aggregator

MAC = "aa:aa:aa:aa:aa:aa"


class AggregatorTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.sqlite3"))

    def tearDown(self):
        self.store.close()
        self.dir.cleanup()

    def test_records_only_home_devices_for_current_minute(self):
        self.store.set_presence("aa:aa:aa:aa:aa:aa", state="home", last_seen=1000, since=1000)
        self.store.set_presence("bb:bb:bb:bb:bb:bb", state="away", last_seen=1000, since=1000)
        self.assertEqual(aggregator.record_minutes(self.store, now=3725), 1)  # минута 3720
        self.assertEqual(self.store.minutes_by_day(0, 4000)[0]["minutes"], 1)

    def test_rollup_then_prune(self):
        self.store.mark_minute(MAC, 60)
        self.store.mark_minute(MAC, 120)
        day = aggregator.day_key(120)
        self.assertEqual(aggregator.rollup_daily(self.store, day), 1)
        self.assertEqual(self.store.minutes_for_day(day)[MAC], 2)
        self.assertEqual(aggregator.rollup_daily(self.store, day), 1)  # идемпотентно

        # retention-окно ещё не истекло — ничего не удаляется
        res = aggregator.prune(self.store, now=200, minute_days=30, daily_days=30)
        self.assertEqual(res, {"minutes": 0, "days": 0})

        # сдвигаем now за окно — старые минуты и дни удаляются
        later = 200 + 31 * 86400
        res2 = aggregator.prune(self.store, now=later, minute_days=30, daily_days=0)
        self.assertEqual(res2, {"minutes": 2, "days": 1})
        self.assertEqual(self.store.minutes_by_day(0, later), [])


if __name__ == "__main__":
    unittest.main()
