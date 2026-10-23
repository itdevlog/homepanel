import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  groupPeople,
  diffEvents,
  barsFromStats,
  isUnidentified,
  deviceLabel,
  filterDevices,
  sortDevices,
  signalLevel,
  formatAgo,
} from "../../static/lib.js";

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0 мин");
  assert.equal(formatDuration(90 * 60), "1 ч 30 мин");
  assert.equal(formatDuration(3600 * 26), "1 д 2 ч");
});

test("groupPeople marks home and earliest since", () => {
  const rows = groupPeople([
    { person: "Иван", state: "home", since: 200, hidden: false },
    { person: "Иван", state: "home", since: 100, hidden: false },
    { person: "Анна", state: "away", since: 100, hidden: false },
    { person: "Пётр", state: "home", since: 100, hidden: true },
  ]);
  assert.deepEqual(rows.map(r => [r.person, r.home, r.since]),
                   [["Иван", true, 100], ["Анна", false, null], ["Пётр", false, null]]);
});

test("diffEvents returns only newer ids", () => {
  const ev = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(diffEvents(ev, 1).map(e => e.id), [2, 3]);
});

test("barsFromStats", () => {
  assert.deepEqual(barsFromStats([{ bucket: "2026-10-14", minutes: 90 }]),
                   [{ label: "2026-10-14", value: 90 }]);
});

// Раньше «неопознанным» считалось всё с trust === "unknown" (это дефолт),
// поэтому размеченные устройства дублировались, а скрытые оставались на главной.
test("isUnidentified only for unnamed, unassigned and visible devices", () => {
  assert.equal(isUnidentified({ name: null, person: null, hidden: false }), true);
  assert.equal(isUnidentified({ name: "Телефон", person: null, hidden: false }), false);
  assert.equal(isUnidentified({ name: null, person: "Иван", hidden: false }), false);
  assert.equal(isUnidentified({ name: null, person: null, hidden: true }), false);
});

// --- Страница «Устройства»: поиск, фильтры, сортировка, сигнал ----------

const DEVICES = [
  { mac: "aa:bb:cc:dd:ee:01", name: "Телефон", person: "Иван", hostname: "phone",
    ip: "192.168.1.10", state: "home", signal: -50, hidden: false },
  { mac: "aa:bb:cc:dd:ee:02", name: null, person: null, hostname: "*",
    ip: null, state: "away", signal: -80, hidden: false },
  { mac: "aa:bb:cc:dd:ee:03", name: "ТВ", person: "Анна", hostname: "tv",
    ip: "192.168.1.12", state: "away", signal: null, hidden: true },
];

const macs = (rows) => rows.map((d) => d.mac.slice(-2));

test("deviceLabel prefers name, then person, then real hostname, then mac", () => {
  assert.equal(deviceLabel(DEVICES[0]), "Телефон");
  assert.equal(deviceLabel({ person: "Анна", mac: "aa:01" }), "Анна");
  assert.equal(deviceLabel({ hostname: "tv", mac: "aa:02" }), "tv");
  assert.equal(deviceLabel({ hostname: "*", mac: "aa:03" }), "aa:03");
  assert.equal(deviceLabel({ hostname: "", mac: "aa:04" }), "aa:04");
});

test("filterDevices searches mac, name, person, hostname and ip", () => {
  assert.deepEqual(macs(filterDevices(DEVICES, "", "all")), ["01", "02", "03"]);
  assert.deepEqual(macs(filterDevices(DEVICES, "телефон")), ["01"]);
  assert.deepEqual(macs(filterDevices(DEVICES, "иван")), ["01"]);
  assert.deepEqual(macs(filterDevices(DEVICES, "ee:02")), ["02"]);
  assert.deepEqual(macs(filterDevices(DEVICES, "192.168.1.12")), ["03"]);
  assert.deepEqual(macs(filterDevices(DEVICES, "  ")), ["01", "02", "03"]);
});

test("filterDevices modes: home, unnamed, hidden", () => {
  assert.deepEqual(macs(filterDevices(DEVICES, "", "home")), ["01"]);
  assert.deepEqual(macs(filterDevices(DEVICES, "", "unknown")), ["02"]);
  assert.deepEqual(macs(filterDevices(DEVICES, "", "hidden")), ["03"]);
  assert.deepEqual(macs(filterDevices(DEVICES, "телефон", "hidden")), []);
});

test("sortDevices: signal puts empty values last in both directions", () => {
  assert.deepEqual(macs(sortDevices(DEVICES, "signal")), ["02", "01", "03"]);
  assert.deepEqual(macs(sortDevices(DEVICES, "signal", "desc")), ["01", "02", "03"]);
});

test("sortDevices: home first, name alphabetical", () => {
  assert.deepEqual(macs(sortDevices(DEVICES, "state")), ["01", "02", "03"]);
  const byName = sortDevices([{ name: "б", mac: "b" }, { name: "а", mac: "a" }], "name");
  assert.deepEqual(byName.map((d) => d.name), ["а", "б"]);
});

test("sortDevices does not mutate the input", () => {
  const rows = DEVICES.slice();
  sortDevices(rows, "signal", "desc");
  assert.deepEqual(macs(rows), ["01", "02", "03"]);
});

test("signalLevel buckets and formatAgo", () => {
  assert.equal(signalLevel(null), "none");
  assert.equal(signalLevel(-80), "weak");
  assert.equal(signalLevel(-75), "weak");
  assert.equal(signalLevel(-70), "fair");
  assert.equal(signalLevel(-50), "good");

  assert.equal(formatAgo(0), "только что");
  assert.equal(formatAgo(4), "только что");
  assert.equal(formatAgo(42), "42 с назад");
  assert.equal(formatAgo(90 * 60), "1 ч 30 мин назад");
});
