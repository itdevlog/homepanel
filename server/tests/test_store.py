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

    def test_role_and_room_columns_are_migrated_and_saved(self):
        mac = "aa:bb:cc:dd:ee:03"
        self.store.upsert_device(mac, role="infra", room="Кухня")
        row = self.store.get_device(mac)
        self.assertEqual(row["role"], "infra")
        self.assertEqual(row["room"], "Кухня")
        self.store._ensure_column("devices", "role", "role TEXT")
        self.store._ensure_column("devices", "room", "room TEXT")

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

    def test_merge_records_alias_and_unmerge_restores_device(self):
        src, dst = "aa:aa:aa:aa:aa:aa", "bb:bb:bb:bb:bb:bb"
        self.store.upsert_device(src, name="Старый")
        self.store.upsert_device(dst, person="Иван")
        self.store.merge_devices(src, dst)
        self.assertEqual(self.store.aliases_for(dst), [src])

        restored = self.store.unmerge_device(src)
        self.assertEqual(restored["mac"], src)
        self.assertEqual(self.store.aliases_for(dst), [])
        self.assertFalse(self.store.unmerge_device(src))

    def test_merge_repoints_existing_aliases(self):
        a, b, c = "aa:aa:aa:aa:aa:01", "aa:aa:aa:aa:aa:02", "aa:aa:aa:aa:aa:03"
        self.store.upsert_device(a, name="A")
        self.store.upsert_device(b, name="B")
        self.store.merge_devices(a, b)
        self.store.merge_devices(b, c)
        self.assertEqual(self.store.aliases_for(c), [a, b])
        self.assertEqual(self.store.aliases_for(b), [])

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

    def test_pause_roundtrip(self):
        self.store.set_control("aa:bb:cc:dd:ee:01", True, 100)
        self.assertTrue(self.store.is_paused("aa:bb:cc:dd:ee:01"))
        self.assertEqual(self.store.paused_macs(), ["aa:bb:cc:dd:ee:01"])
        self.store.set_control("aa:bb:cc:dd:ee:01", False, 200)
        self.assertEqual(self.store.paused_macs(), [])

    def test_command_lifecycle_dedup_and_timeout(self):
        first = self.store.create_command("kick", "aa:bb:cc:dd:ee:01", 1000)
        same = self.store.create_command("kick", "aa:bb:cc:dd:ee:01", 1001)
        self.assertEqual(first["id"], same["id"])
        pending = self.store.pending_commands(1002)
        self.assertEqual([c["id"] for c in pending], [first["id"]])
        self.store.mark_commands_sent([first["id"]], 1003)
        self.assertEqual(self.store.pending_commands(1004), [])
        self.store.apply_acks([{"id": first["id"], "ok": True}], 1005)
        self.assertEqual(self.store.recent_commands(1)[0]["status"], "done")
        # повторный ack не меняет статус
        self.store.apply_acks([{"id": first["id"], "ok": False, "error": "late"}], 1006)
        self.assertEqual(self.store.recent_commands(1)[0]["status"], "done")
        # истёкшая команда
        old = self.store.create_command("kick", "aa:bb:cc:dd:ee:02", 2000)
        self.assertIsNotNone(old["id"])
        self.store.expire_commands(2000 + 61)
        self.assertEqual(self.store.recent_commands(1)[0]["status"], "error")
        self.assertEqual(self.store.pending_commands(3000), [])

    def test_traffic_deltas_first_sample_reset_and_bucket(self):
        mac = "aa:bb:cc:dd:ee:01"
        self.store.record_traffic(1000, [(mac, 100, 200)])
        self.assertEqual(self.store.last_traffic()[mac]["rx_bytes"], 100)
        self.assertEqual(self.store.traffic_series(mac, 0, 2000)[0]["rx_bytes"], 0)
        self.store.record_traffic(1100, [(mac, 150, 260)])
        series = self.store.traffic_series(mac, 0, 2000)
        self.assertEqual((series[-1]["rx_bytes"], series[-1]["tx_bytes"]), (50, 60))
        self.store.record_traffic(1200, [(mac, 10, 20)])  # сброс счётчика
        series = self.store.traffic_series(mac, 0, 2000)
        self.assertEqual((series[-1]["rx_bytes"], series[-1]["tx_bytes"]), (10, 20))

    def test_router_sample_throttle_and_series(self):
        self.store.record_router(
            1000,
            {
                "uptime": 10,
                "load1": 0.1,
                "mem_total": 100,
                "mem_free": 50,
                "wan_up": True,
            },
        )
        self.store.record_router(
            1005,
            {
                "uptime": 15,
                "load1": 0.2,
                "mem_total": 100,
                "mem_free": 40,
                "wan_up": False,
            },
        )
        self.assertEqual(len(self.store.router_series(0, 2000, "hour")), 1)
        self.assertEqual(self.store.router_latest()["wan_up"], True)


    def test_ap_names_roundtrip(self):
        self.store.set_ap_name("phy0-ap0", "FREE", 1000)
        self.assertEqual(self.store.get_ap_names(), {"phy0-ap0": "FREE"})
        self.assertEqual(self.store.delete_ap_name("phy0-ap0"), 1)
        self.assertEqual(self.store.get_ap_names(), {})


    def test_rooms_and_types_roundtrip(self):
        self.store.add_room("Кухня", 1, 1000)
        self.store.add_room("Спальня", 2, 1000)
        self.assertEqual(
            [room["name"] for room in self.store.get_rooms()], ["Кухня", "Спальня"]
        )
        self.store.upsert_device_type("lamp", "Лампа", "light", 1000)
        types = {item["key"]: item for item in self.store.get_device_types()}
        self.assertEqual(types["lamp"]["icon"], "light")
        self.assertEqual(self.store.delete_device_type("phone"), 0)

        mac = "aa:bb:cc:dd:ee:77"
        self.store.upsert_device(mac, room="Кухня", kind="lamp", icon="light")
        self.assertEqual(self.store.rename_room("Кухня", "Кухня-2"), 1)
        self.assertEqual(self.store.get_device(mac)["room"], "Кухня-2")
        self.assertEqual(self.store.delete_room("Кухня-2"), 1)
        self.assertEqual(self.store.get_device(mac)["room"], "")


    def test_nlbw_deltas_series_and_prune(self):
        mac = "aa:bb:cc:dd:ee:98"
        self.store.record_nlbw(1000, {mac: {"rx_bytes": 100, "tx_bytes": 200}})
        self.store.record_nlbw(1300, {mac: {"rx_bytes": 160, "tx_bytes": 260}})
        series = self.store.nlbw_series(mac, 0, 2000)
        self.assertEqual(
            [(row["rx_bytes"], row["tx_bytes"]) for row in series],
            [(0, 0), (60, 60)],
        )
        self.assertEqual(self.store.nlbw_deltas(0)[mac]["rx_bytes"], 60)
        self.assertEqual(self.store.prune_nlbw(1200), 1)

    def test_traffic_totals_groups_by_mac_and_source(self):
        mac = "aa:bb:cc:dd:ee:99"
        self.store.record_traffic(1000, [(mac, 100, 200)])
        self.store.record_traffic(1100, [(mac, 150, 260)])
        self.store.record_nlbw(1000, {mac: {"rx_bytes": 10, "tx_bytes": 20}})
        self.store.record_nlbw(1100, {mac: {"rx_bytes": 40, "tx_bytes": 60}})

        totals = self.store.traffic_totals(0, 2000)
        self.assertEqual(totals["wifi"][mac]["rx_bytes"], 50)
        self.assertEqual(totals["wifi"][mac]["tx_bytes"], 60)
        self.assertEqual(totals["nlbw"][mac]["rx_bytes"], 30)
        self.assertEqual(totals["nlbw"][mac]["tx_bytes"], 40)

    def test_light_state_events_and_minutes(self):
        self.store.set_light_state("Кухня", True, 1000, 4, 3, 1000)
        states = self.store.get_light_states()
        self.assertEqual(states[0]["room"], "Кухня")
        self.assertTrue(states[0]["on"])
        self.assertEqual(states[0]["online"], 3)
        self.store.add_light_event("Кухня", "on", 1000, 3)
        self.assertEqual(self.store.get_light_events(5)[0]["state"], "on")
        self.assertEqual(self.store.prune_light_events(1500), 1)
        mac = "aa:bb:cc:dd:ee:80"
        self.store.mark_minute(mac, 120)
        rows = self.store.light_minutes(0, 200, [mac])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["mac"], mac)


    def test_promote_alias_swaps_primary(self):
        primary = "aa:bb:cc:dd:ee:a1"
        secondary = "aa:bb:cc:dd:ee:a2"
        self.store.upsert_device(primary, name="Телефон", person="Иван", room="Кухня")
        self.store.upsert_device(secondary)
        self.store.merge_devices(primary, secondary)
        self.store.set_presence(secondary, state="home", last_seen=1100, since=1100)
        row = self.store.promote_alias(primary, secondary, 2000)
        self.assertEqual(row["mac"], primary)
        self.assertEqual(row["name"], "Телефон")
        self.assertEqual(row["person"], "Иван")
        self.assertEqual(row["room"], "Кухня")
        self.assertIsNone(self.store.get_device(secondary))
        self.assertEqual(self.store.aliases_for(primary), [secondary])
        self.assertEqual(self.store.get_presence(primary)["state"], "home")


if __name__ == "__main__":
    unittest.main()
