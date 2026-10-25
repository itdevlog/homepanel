import os
import tempfile
import time
import unittest

from homepanel.store import Store


class DevicesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.sqlite3"))

    def tearDown(self):
        self.store.close()
        self.dir.cleanup()

    def test_upsert_insert_then_partial_update(self):
        d = self.store.upsert_device("AA:BB:CC:DD:EE:FF", name="Телефон", person="Иван")
        self.assertEqual(d["mac"], "aa:bb:cc:dd:ee:ff")  # нормализация в нижний регистр
        self.assertEqual(d["trust"], "unknown")
        d2 = self.store.upsert_device("aa:bb:cc:dd:ee:ff", kind="phone")
        self.assertEqual((d2["name"], d2["kind"], d2["person"]), ("Телефон", "phone", "Иван"))

    def test_link_columns_are_migrated_and_saved(self):
        self.store.set_links("aa:bb:cc:dd:ee:01", "wired")
        self.assertEqual(self.store.get_links()["aa:bb:cc:dd:ee:01"], "wired")
        # повторный вызов не должен падать и не должен дублировать колонку
        self.store._ensure_column("devices", "link", "link TEXT")

    def test_merge_moves_reference_and_deletes_source(self):
        self.store.upsert_device("aa:aa:aa:aa:aa:aa", name="Старый")
        self.store.upsert_device("bb:bb:bb:bb:bb:bb", person="Иван")
        merged = self.store.merge_devices("aa:aa:aa:aa:aa:aa", "bb:bb:bb:bb:bb:bb")
        self.assertEqual(merged["person"], "Иван")
        self.assertIsNone(self.store.get_device("aa:aa:aa:aa:aa:aa"))

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
        self.store.add_event(mac, "arrived", 100)
        self.store.add_event(mac, "arrived", 300)
        self.assertEqual(self.store.prune_events(200), 1)

    def test_agent_uptime_and_prune(self):
        base = int(time.mktime((2026, 10, 14, 12, 0, 0, 0, 0, -1)))
        self.store.mark_agent_seen(base)
        self.store.mark_agent_seen(base + 30)  # та же минута — дубль игнорируется
        self.store.mark_agent_seen(base + 60)
        rows = self.store.agent_uptime(base - 3600, base + 3600)
        self.assertEqual(sum(row["minutes"] for row in rows), 2)
        self.assertEqual(self.store.last_agent_seen(), base + 60)
        self.assertEqual(self.store.prune_agent_seen(base + 60), 1)

    def test_change_log_roundtrip_and_prune(self):
        self.store.log_change(100, "device.update", "aa:bb:cc:dd:ee:ff", "name")
        self.store.log_change(200, "rule.add", None, "iphone*")
        rows = self.store.get_changes()
        self.assertEqual([row["action"] for row in rows], ["rule.add", "device.update"])
        self.assertEqual(self.store.prune_changes(150), 1)

    def test_snapshot_and_replace_roundtrip(self):
        mac = "aa:bb:cc:dd:ee:03"
        self.store.upsert_device(mac, name="Тест")
        data = self.store.snapshot_bytes()
        self.assertTrue(data.startswith(b"SQLite format 3\x00"))
        self.store.forget_device(mac)
        self.assertIsNone(self.store.get_device(mac))
        out = self.store.replace_from_bytes(data)
        self.assertEqual(out["devices"], 1)
        self.assertEqual(self.store.get_device(mac)["name"], "Тест")

    def test_merge_into_self_is_rejected(self):
        """Раньше src == dst приводил к удалению самого устройства."""
        self.store.upsert_device("aa:aa:aa:aa:aa:aa", name="X")
        with self.assertRaises(ValueError):
            self.store.merge_devices("aa:aa:aa:aa:aa:aa", "aa:aa:aa:aa:aa:aa")
        self.assertIsNotNone(self.store.get_device("aa:aa:aa:aa:aa:aa"))

    def test_signal_samples_are_bucketed_and_pruned(self):
        mac = "aa:bb:cc:dd:ee:ff"
        self.store.add_signal_sample(mac, 301, -50)
        self.store.add_signal_sample(mac, 599, -60)  # тот же пятиминутный бакет

        self.assertEqual(
            self.store.signal_series(mac, 0, 1000),
            [{"ts": 300, "signal": -60}],
        )
        self.assertEqual(self.store.prune_signals(400), 1)
        self.assertEqual(self.store.signal_series(mac, 0, 1000), [])

    def test_occupancy_union_and_device_matrix(self):
        first, second = "aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02"
        for minute in (3600, 3660, 3720):
            self.store.mark_minute(first, minute)
        self.store.mark_minute(second, 3660)

        self.assertEqual(
            self.store.occupancy_by_hour(3600, 7200),
            [{"hour_ts": 3600, "devices": 2}],
        )
        # Объединение минут не считает две квартиры дважды за одну минуту.
        self.assertEqual(self.store.minutes_union(3600, 7200), 3)
        self.assertEqual(self.store.minutes_union(3600, 7200, [first]), 3)
        self.assertEqual(
            self.store.device_hour_matrix(3600, 7200),
            [
                {"mac": first, "hour_ts": 3600, "minutes": 3},
                {"mac": second, "hour_ts": 3600, "minutes": 1},
            ],
        )
        self.assertEqual(self.store.minute_timestamps(3600, 7200), [3600, 3660, 3720])

    def test_events_between_and_hour_counts(self):
        mac = "aa:bb:cc:dd:ee:ff"
        morning = int(time.mktime((2026, 10, 14, 9, 0, 0, 0, 0, -1)))
        evening = int(time.mktime((2026, 10, 14, 20, 0, 0, 0, 0, -1)))
        self.store.add_event(mac, "arrived", morning)
        self.store.add_event(mac, "left", evening)

        self.assertEqual(len(self.store.events_between(morning, morning + 86400)), 2)
        counts = self.store.event_counts_by_hour(morning, morning + 86400)
        self.assertEqual(len(counts), 24)
        self.assertEqual(counts[9]["arrived"], 1)
        self.assertEqual(counts[20]["left"], 1)

    def test_devices_created_between(self):
        mac = "aa:bb:cc:dd:ee:ff"
        self.store.upsert_device(mac, name="X")
        created = self.store.get_device(mac)["created_at"]
        self.assertEqual(self.store.devices_created_between(created, created), [created])
        self.assertEqual(self.store.devices_created_between(created + 1, created + 2), [])

    # -- разметка, правила и забывание ------------------------------------

    def test_bulk_update_creates_and_updates(self):
        first = "aa:bb:cc:dd:ee:01"
        second = "aa:bb:cc:dd:ee:02"
        self.store.upsert_device(second, name="Старое")

        updated = self.store.bulk_update(
            [first, second], {"person": "Иван", "hidden": True}
        )
        self.assertEqual(updated, 2)
        row = self.store.get_device(first)
        self.assertEqual(row["person"], "Иван")
        self.assertTrue(row["hidden"])
        row = self.store.get_device(second)
        self.assertEqual(row["name"], "Старое")
        self.assertTrue(row["hidden"])

    def test_bulk_update_ignores_unknown_fields(self):
        mac = "aa:bb:cc:dd:ee:01"
        self.store.bulk_update([mac], {"evil": "x", "person": "A"})
        row = self.store.get_device(mac)
        self.assertEqual(row["person"], "A")
        self.assertNotIn("evil", row)

    def test_forget_device_wipes_rows(self):
        mac = "aa:bb:cc:dd:ee:01"
        self.store.upsert_device(mac, name="X")
        self.store.set_presence(mac, state="home", last_seen=1000, since=1000)
        self.store.add_event(mac, "arrived", 1000)
        self.store.mark_minute(mac, 1000)
        self.store.add_signal_sample(mac, 1000, -50)

        self.assertTrue(self.store.forget_device(mac))
        self.assertIsNone(self.store.get_device(mac))
        self.assertEqual(self.store.all_presence(), [])
        self.assertEqual(self.store.get_events(None, 10), [])
        self.assertEqual(self.store.signal_series(mac, 0, 2000), [])
        self.assertEqual(self.store.minute_timestamps(0, 2000), [])

    def test_rules_crud_and_replace(self):
        rule = self.store.add_rule("iphone*", person="Иван", kind="phone")
        self.assertEqual(self.store.get_rules()[0]["pattern"], "iphone*")
        self.assertTrue(self.store.delete_rule(rule["id"]))
        self.assertEqual(self.store.get_rules(), [])

        count = self.store.replace_rules(
            [{"pattern": "tv-*", "kind": "tv"}, {"pattern": "x"}]
        )
        self.assertEqual(count, 2)
        patterns = [row["pattern"] for row in self.store.get_rules()]
        self.assertEqual(patterns, ["tv-*", "x"])

    def test_macs_in_range(self):
        first = "aa:bb:cc:dd:ee:01"
        second = "aa:bb:cc:dd:ee:02"
        self.store.mark_minute(first, 1000)
        self.store.mark_minute(second, 2000)
        self.assertEqual(self.store.macs_in_range(0, 1500), {first})
        self.assertEqual(self.store.macs_in_range(0, 3000), {first, second})


if __name__ == "__main__":
    unittest.main()
