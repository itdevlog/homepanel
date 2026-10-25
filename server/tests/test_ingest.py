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


def _snap(clients, **extra):
    payload = {
        "schema": 2,
        "agent": {"hostname": "r1", "version": "2.0", "ts": 1000},
        "clients": clients,
        **extra,
    }
    return parse_snapshot(json.dumps(payload).encode())


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
        bad = dict(VALID, schema=3)
        with self.assertRaises(IngestError):
            parse_snapshot(json.dumps(bad).encode())

    def test_skips_malformed_clients_but_empty_list_is_valid(self):
        bad = dict(VALID, clients=[{"mac": "nope"}, {"bss": "x"}])
        self.assertEqual(parse_snapshot(json.dumps(bad).encode()).clients, [])
        self.assertEqual(
            parse_snapshot(json.dumps(dict(VALID, clients=[])).encode()).clients, []
        )


    def test_schema2_client_defaults_and_values(self):
        snap = _snap(
            [
                {"mac": "aa:bb:cc:dd:ee:01"},
                {"mac": "aa:bb:cc:dd:ee:02", "link": "wired", "rx_bytes": 10, "tx_bytes": 20},
            ]
        )
        self.assertEqual(snap.clients[0].link, "wifi")
        self.assertIsNone(snap.clients[0].rx_bytes)
        self.assertEqual(snap.clients[1].link, "wired")
        self.assertEqual((snap.clients[1].rx_bytes, snap.clients[1].tx_bytes), (10, 20))

    def test_schema2_rejects_too_new_schema(self):
        with self.assertRaises(IngestError) as ctx:
            _snap([], schema=3)
        self.assertEqual(ctx.exception.reason, "unsupported_schema")

    def test_schema2_router_and_acks(self):
        snap = _snap(
            [],
            router={
                "uptime": 50,
                "load1": 0.5,
                "mem_total": 100,
                "mem_free": 40,
                "wan_up": True,
            },
            acks=[{"id": 3, "ok": True}, {"id": 4, "ok": False, "error": "nft"}],
            errors=["iwinfo unavailable"],
        )
        self.assertEqual(snap.router.uptime, 50)
        self.assertEqual(snap.router.load1, 0.5)
        self.assertTrue(snap.router.wan_up)
        self.assertEqual([a["id"] for a in snap.acks], [3, 4])
        self.assertEqual(snap.errors, ["iwinfo unavailable"])

    def test_schema2_bad_bytes_and_link_are_tolerated(self):
        snap = _snap(
            [
                {
                    "mac": "aa:bb:cc:dd:ee:03",
                    "link": "zigbee",
                    "rx_bytes": -5,
                    "tx_bytes": "x",
                }
            ]
        )
        client = snap.clients[0]
        self.assertEqual(client.link, "wifi")
        self.assertIsNone(client.rx_bytes)
        self.assertIsNone(client.tx_bytes)


if __name__ == "__main__":
    unittest.main()
