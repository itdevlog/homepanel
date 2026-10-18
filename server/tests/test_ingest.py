import json
import unittest

from homepanel.ingest import IngestError, parse_snapshot

VALID = {
    "schema": 1,
    "agent": {"hostname": "OpenWrt", "version": "1.0", "ts": 1760000000},
    "clients": [
        {
            "mac": "AA:BB:CC:DD:EE:FF",
            "bss": "phy0-ap0",
            "band": "2.4",
            "signal": -52,
            "ip": "192.168.1.42",
            "hostname": "iPhone",
        }
    ],
}


class IngestTest(unittest.TestCase):
    def test_parses_and_normalizes(self):
        s = parse_snapshot(json.dumps(VALID).encode())
        self.assertEqual(s.schema, 1)
        self.assertEqual(s.clients[0].mac, "aa:bb:cc:dd:ee:ff")

    def test_rejects_non_json_and_non_object(self):
        for raw in (b"not json", b"[1,2,3]", b"null"):
            with self.assertRaises(IngestError):
                parse_snapshot(raw)

    def test_rejects_schema_above_one(self):
        bad = dict(VALID, schema=2)
        with self.assertRaises(IngestError):
            parse_snapshot(json.dumps(bad).encode())

    def test_skips_malformed_clients_but_empty_list_is_valid(self):
        bad = dict(VALID, clients=[{"mac": "nope"}, {"bss": "x"}])
        self.assertEqual(parse_snapshot(json.dumps(bad).encode()).clients, [])
        self.assertEqual(
            parse_snapshot(json.dumps(dict(VALID, clients=[])).encode()).clients, []
        )


if __name__ == "__main__":
    unittest.main()
