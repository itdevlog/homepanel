import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  groupPeople,
  diffEvents,
  barsFromStats,
  isUnidentified,
  groupByRoom,
  deviceLabel,
  filterDevices,
  sortDevices,
  signalLevel,
  formatAgo,
  sanitizeFilters,
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
  assert.equal(isUnidentified({ name: null, person: null, hidden: false, role: "infra" }), false);
  assert.equal(isUnidentified({ name: null, person: null, hidden: false, role: "guest" }), false);
  assert.equal(isUnidentified({ name: null, person: null, hidden: false, role: "person" }), true);
});

test("sanitizeFilters restores a valid schema", () => {
  assert.deepEqual(sanitizeFilters(null), { people: [], devices: [] });
  assert.deepEqual(sanitizeFilters({ people: "Иван", devices: [1, "aa:bb"] }), {
    people: [],
    devices: ["aa:bb"],
  });
  assert.deepEqual(
    sanitizeFilters({ people: [" Иван ", "Иван", ""], devices: ["aa:bb"] }),
    { people: ["Иван"], devices: ["aa:bb"] },
  );
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

test("filterDevices unknown excludes infrastructure and guests", () => {
  const devices = [
    { mac: "01", name: null, person: null, hidden: false, role: "infra" },
    { mac: "02", name: null, person: null, hidden: false, role: "guest" },
    { mac: "03", name: null, person: null, hidden: false, role: "person" },
    { mac: "04", name: null, person: null, hidden: false },
  ];
  assert.deepEqual(macs(filterDevices(devices, "", "unknown")), ["03", "04"]);
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

// --- Новые возможности: темы, CSV, дубли, алерты, аналитика ---------------

import {
  plural,
  nextTheme,
  lastSeenText,
  csvEscape,
  toCsv,
  csvFilename,
  duplicateGroups,
  alertsFromState,
  heatmapGrid,
  timelineSegments,
  filterEvents,
  donutSegments,
  hourlyBuckets,
  escapeHtml,
  stripGuestParam,
  calendarLevel,
  searchMatches,
} from "../../static/lib.js";

test("plural picks the Russian form", () => {
  assert.equal(plural(1, "устройство", "устройства", "устройств"), "устройство");
  assert.equal(plural(2, "устройство", "устройства", "устройств"), "устройства");
  assert.equal(plural(5, "устройство", "устройства", "устройств"), "устройств");
  assert.equal(plural(11, "устройство", "устройства", "устройств"), "устройств");
  assert.equal(plural(21, "устройство", "устройства", "устройств"), "устройство");
});

test("nextTheme cycles auto → dark → light", () => {
  assert.equal(nextTheme("auto"), "dark");
  assert.equal(nextTheme("dark"), "light");
  assert.equal(nextTheme("light"), "auto");
  assert.equal(nextTheme("unknown"), "auto");
});

test("lastSeenText shows home, never seen and time since left", () => {
  assert.equal(lastSeenText({ state: "home" }, 1000), "дома");
  assert.equal(lastSeenText({ state: "away", last_seen: null }, 1000), "не видели");
  assert.equal(lastSeenText({ state: "away", last_seen: 100000 - 90 * 60 }, 100000), "ушёл 1 ч 30 мин назад");
});

test("csvEscape quotes separators and quotes", () => {
  assert.equal(csvEscape("просто"), "просто");
  assert.equal(csvEscape("a;b"), '"a;b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape("a\nb"), '"a\nb"');
  assert.equal(csvEscape(null), "");
  assert.equal(csvEscape(42), "42");
});

test("csvEscape neutralizes spreadsheet formulas", () => {
  assert.equal(csvEscape("=1+1"), "'=1+1");
  assert.equal(csvEscape("+cmd"), "'+cmd");
  assert.equal(csvEscape("-2+3"), "'-2+3");
  assert.equal(csvEscape("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvEscape(" безопасно"), " безопасно");
});

test("escapeHtml escapes user-visible text", () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
  );
  assert.equal(escapeHtml("a & b"), "a &amp; b");
});

test("stripGuestParam removes only the guest token", () => {
  assert.deepEqual(stripGuestParam("?guest=secret&x=1"), {
    token: "secret",
    search: "?x=1",
  });
  assert.deepEqual(stripGuestParam("?x=1"), { token: "", search: "?x=1" });
  assert.deepEqual(stripGuestParam(""), { token: "", search: "" });
});

test("toCsv builds header, rows and CRLF", () => {
  const columns = [
    { label: "MAC", value: (row) => row.mac },
    { label: "Имя", value: (row) => row.name },
  ];
  assert.equal(
    toCsv(columns, [{ mac: "aa:01", name: "Телефон" }, { mac: "aa:02", name: 'ТВ; "кухня"' }]),
    "MAC;Имя\r\naa:01;Телефон\r\naa:02;\"ТВ; \"\"кухня\"\"\"\r\n",
  );
});

test("csvFilename uses the local date", () => {
  assert.equal(csvFilename("homepanel-devices", new Date(2026, 0, 5)), "homepanel-devices-2026-01-05.csv");
});

test("duplicateGroups groups by hostname, falls back to ip, ignores '*'", () => {
  const devices = [
    { mac: "aa:01", hostname: "Phone", ip: "192.168.1.10" },
    { mac: "aa:02", hostname: "phone", ip: "192.168.1.11" },
    { mac: "aa:03", hostname: "*", ip: "192.168.1.12" },
    { mac: "aa:04", hostname: "*", ip: "192.168.1.12" },
    { mac: "aa:05", hostname: "*", ip: "192.168.1.13" },
    { mac: "aa:06" },
  ];
  const groups = duplicateGroups(devices);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.key).sort(), ["host:phone", "ip:192.168.1.12"]);
  assert.equal(groups.find((g) => g.key === "host:phone").devices.length, 2);
});

test("alertsFromState reports missing data, stale agent and unknown devices", () => {
  assert.deepEqual(alertsFromState(null), []);
  assert.deepEqual(alertsFromState({ devices: [] }).map((a) => a.key), ["no-data"]);

  const offline = alertsFromState({
    now: 10_000,
    agent: { online: false, last_snapshot_ts: 10_000 - 1200 },
    devices: [],
  });
  assert.deepEqual(offline.map((a) => [a.key, a.level]), [["agent-offline", "danger"]]);
  assert.match(offline[0].text, /20 мин/);

  const unknown = alertsFromState({
    now: 10_000,
    agent: { online: true, last_snapshot_ts: 9_990 },
    devices: [
      { mac: "aa:01", state: "home" },
      { mac: "aa:02", state: "away" },
    ],
  });
  assert.deepEqual(unknown.map((a) => a.key), ["unknown"]);
  assert.match(unknown[0].text, /^Дома 1 неопознанное устройство$/);
});

test("heatmapGrid fills 7×24 cells with local midnights", () => {
  const now = Math.round(new Date(2026, 9, 24, 12, 0, 0).getTime() / 1000);
  const ts = Math.round(new Date(2026, 9, 23, 10, 0, 0).getTime() / 1000);
  const grid = heatmapGrid([{ hour_ts: ts, devices: 3 }], now, 2);
  assert.equal(grid.rows.length, 2);
  assert.equal(grid.rows[0].date, "2026-10-23");
  assert.equal(grid.rows[0].label, "23.10");
  assert.equal(grid.rows[1].date, "2026-10-24");
  assert.equal(grid.rows[0].cells.length, 24);
  assert.equal(grid.rows[0].cells[10].value, 3);
  assert.equal(grid.rows[0].cells[11].value, 0);
  assert.equal(grid.max, 3);
});

test("timelineSegments converts intervals to percentages", () => {
  const segments = timelineSegments([{ from: 25, to: 75 }], 0, 100);
  assert.equal(segments[0].left, 25);
  assert.equal(segments[0].width, 50);
  const tiny = timelineSegments([{ from: 50, to: 50.001 }], 0, 100);
  assert.equal(tiny[0].width, 0.3);
});

test("filterEvents filters by query, type and period", () => {
  const events = [
    { ts: 100, type: "arrived", mac: "aa:01", label: "Телефон" },
    { ts: 200, type: "left", mac: "aa:02", label: "ТВ" },
    { ts: 300, type: "arrived", mac: "aa:03", ip: "192.168.1.5" },
  ];
  assert.equal(filterEvents(events, {}).length, 3);
  assert.deepEqual(filterEvents(events, { type: "arrived" }).map((e) => e.ts), [100, 300]);
  assert.deepEqual(filterEvents(events, { query: "телефон" }).map((e) => e.ts), [100]);
  assert.deepEqual(filterEvents(events, { query: "192.168.1.5" }).map((e) => e.ts), [300]);
  assert.deepEqual(filterEvents(events, { from: 150, to: 250 }).map((e) => e.ts), [200]);
});

test("hourlyBuckets sums samples into local clock hours", () => {
  const at = (hour, minute) =>
    Math.floor(new Date(2026, 9, 14, hour, minute, 0).getTime() / 1000);
  const rows = hourlyBuckets(
    [
      { ts: at(10, 5), value: 2 },
      { ts: at(10, 55), value: 3 },
      { ts: at(11, 1), value: 7 },
    ],
    (sample) => sample.value,
  );
  assert.deepEqual(
    rows.map((row) => [new Date(row.ts * 1000).getHours(), row.value]),
    [[10, 5], [11, 7]],
  );
});

test("donutSegments computes shares and offsets", () => {
  const segments = donutSegments([
    { label: "Иван", value: 1 },
    { label: "Анна", value: 3 },
  ]);
  assert.equal(segments[0].share, 0.25);
  assert.equal(segments[0].offset, 0);
  assert.equal(segments[1].share, 0.75);
  assert.equal(segments[1].offset, 0.25);
  assert.deepEqual(donutSegments([{ label: "x", value: 0 }]).map((s) => s.share), [0]);
});

test("calendarLevel maps minutes to 0..4", () => {
  assert.equal(calendarLevel(0, 100), 0);
  assert.equal(calendarLevel(1, 100), 1);
  assert.equal(calendarLevel(50, 100), 2);
  assert.equal(calendarLevel(100, 100), 4);
  assert.equal(calendarLevel(1000, 100), 4);
});

test("searchMatches finds devices and events", () => {
  const devices = [
    { mac: "aa:01", name: "iPhone", person: "Иван" },
    { mac: "bb:02", hostname: "tv-living" },
  ];
  const events = [
    { ts: 100, type: "arrived", mac: "aa:01", label: "iPhone" },
    { ts: 200, type: "left", mac: "bb:02", label: "tv-living" },
  ];

  assert.deepEqual(searchMatches(devices, events, ""), { devices: [], events: [] });
  assert.deepEqual(searchMatches(devices, events, "иван").devices.map((d) => d.mac), ["aa:01"]);
  assert.deepEqual(searchMatches(devices, events, "tv").devices.map((d) => d.mac), ["bb:02"]);
  const hits = searchMatches(devices, events, "iphone");
  assert.equal(hits.events.length, 1);
  assert.equal(hits.events[0].ts, 100);
});

import { isRandomMac } from "../../static/lib.js";

test("isRandomMac detects locally administered addresses", () => {
  assert.equal(isRandomMac("da:a1:23:45:67:89"), true);
  assert.equal(isRandomMac("02:11:22:33:44:55"), true);
  assert.equal(isRandomMac("a4:83:e7:11:22:33"), false);
  assert.equal(isRandomMac(""), false);
});

import { formatBytes } from "../../static/lib.js";

test("formatBytes renders readable sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5 MiB");
});

import { ICONS, iconGlyph } from "../../static/lib.js";

test("iconGlyph returns catalog glyph", () => {
  assert.equal(iconGlyph("phone"), "📱");
  assert.equal(iconGlyph("nope"), "❔");
  assert.ok(ICONS.length >= 10);
});

test("groupByRoom groups all devices and counts online", () => {
  const groups = groupByRoom([
    { mac: "1", role: "infra", room: "Кухня", state: "home", hidden: false },
    { mac: "2", role: "infra", room: "Кухня", state: "away", hidden: false },
    { mac: "3", role: "infra", room: "Кухня", state: "home", hidden: true },
    { mac: "4", role: "infra", room: "", state: "home", hidden: false },
    { mac: "5", role: "person", room: "Кухня", state: "home", hidden: false },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.room, group.total, group.online]),
    [["Кухня", 4, 2], ["", 1, 1]],
  );
});
