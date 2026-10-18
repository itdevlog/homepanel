import os
import tempfile
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

    def test_merge_moves_reference_and_deletes_source(self):
        self.store.upsert_device("aa:aa:aa:aa:aa:aa", name="Старый")
        self.store.upsert_device("bb:bb:bb:bb:bb:bb", person="Иван")
        merged = self.store.merge_devices("aa:aa:aa:aa:aa:aa", "bb:bb:bb:bb:bb:bb")
        self.assertEqual(merged["person"], "Иван")
        self.assertIsNone(self.store.get_device("aa:aa:aa:aa:aa:aa"))


if __name__ == "__main__":
    unittest.main()
