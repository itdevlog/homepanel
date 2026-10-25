import json
import os
import tempfile
import unittest

from homepanel.config import load_config


class ConfigTest(unittest.TestCase):
    def test_defaults_when_no_path(self):
        c = load_config(None)
        self.assertEqual((c.host, c.port, c.secret), ("127.0.0.1", 8787, "CHANGE_ME"))
        self.assertEqual(
            (c.grace_seconds, c.minute_retention_days, c.daily_retention_days),
            (300, 30, 365),
        )
        self.assertEqual(c.signal_retention_days, 7)

    def test_retention_overrides(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "config.json")
            with open(p, "w") as f:
                json.dump({"retention": {"signalDays": 3}}, f)
            self.assertEqual(load_config(p).signal_retention_days, 3)

    def test_file_overrides_and_unknown_keys_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "config.json")
            with open(p, "w") as f:
                json.dump({"port": 9999, "graceSeconds": 60, "bogus": 1}, f)
            c = load_config(p)
            self.assertEqual((c.port, c.grace_seconds), (9999, 60))

    def test_missing_file_is_defaults(self):
        self.assertEqual(load_config("/nonexistent/x.json").port, 8787)


    def test_ap_names_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "config.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"apNames": {"phy0-ap0": "FREE", "phy1-ap0": "FREE-5HZ"}}, handle)
            cfg = load_config(path)
        self.assertEqual(cfg.ap_names["phy0-ap0"], "FREE")
        self.assertEqual(cfg.ap_names["phy1-ap0"], "FREE-5HZ")
        self.assertEqual(len(cfg.ap_names), 2)


if __name__ == "__main__":
    unittest.main()
