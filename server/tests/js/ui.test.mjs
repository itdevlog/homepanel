import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(
  new URL("../../static/views/home.js", import.meta.url),
  "utf8",
);

test("router card offers agent restart", () => {
  assert.match(home, /router-restart/);
  assert.match(home, /controlRestart/);
});

const devices = readFileSync(
  new URL("../../static/views/devices.js", import.meta.url),
  "utf8",
);
const settings = readFileSync(
  new URL("../../static/views/settings.js", import.meta.url),
  "utf8",
);

test("home renders infrastructure by rooms", () => {
  assert.match(home, /infraBlock/);
  assert.match(home, /infra-grid/);
  assert.match(home, /infraDeviceRow/);
  assert.match(home, /infra-device/);
  assert.match(home, /"в сети"/);
  assert.match(home, /"не в сети"/);
});

test("device editor exposes role and room", () => {
  assert.match(devices, /name="role"/);
  assert.match(devices, /name="room"/);
});

test("label rules support role and room", () => {
  assert.match(settings, /rule-role/);
  assert.match(settings, /rule-room/);
});

test("merged devices can be split back", () => {
  assert.match(devices, /unmerge-btn/);
  assert.match(devices, /unmergeDevice/);
});

test("panel shows friendly AP names", () => {
  assert.match(devices, /bss_name/);
  assert.match(home, /bss_name/);
});

test("settings edits access point names", () => {
  assert.match(settings, /ap-name/);
  assert.match(settings, /saveApName/);
});

test("settings manages rooms and device types", () => {
  assert.match(settings, /dictionariesHtml/);
  assert.match(settings, /saveRoom/);
  assert.match(settings, /saveType/);
});

test("home shows device icons", () => {
  assert.match(home, /iconGlyph/);
});

test("devices can filter by room, kind and person", () => {
  assert.match(devices, /room-filter/);
  assert.match(devices, /kind-filter/);
  assert.match(devices, /person-filter/);
  assert.match(devices, /filtersHtml/);
});

test("analytics shows a traffic table instead of a per-device chart", () => {
  const analytics = readFileSync(
    new URL("../../static/views/analytics.js", import.meta.url),
    "utf8",
  );
  assert.match(analytics, /traffic-table-host/);
  assert.match(analytics, /loadTrafficTable/);
  assert.match(analytics, /getTrafficTable/);
  assert.doesNotMatch(analytics, /traffic-mac/);
});

test("analytics shows all people and drops the four extra reports", () => {
  const analytics = readFileSync(
    new URL("../../static/views/analytics.js", import.meta.url),
    "utf8",
  );
  assert.match(analytics, /Promise\.all/);
  assert.match(analytics, /timeline-person/);
  assert.doesNotMatch(analytics, /loadCalendar|loadCompare|loadReport|loadDays/);
  assert.doesNotMatch(analytics, /Календарь присутствия|Сравнение недель|Итоги недели|Время дома по дням/);
});

test("devices group infrastructure by room", () => {
  assert.match(devices, /group-toggle/);
  assert.match(devices, /groupByRoom/);
});

test("home and analytics show light monitoring", () => {
  const analytics = readFileSync(
    new URL("../../static/views/analytics.js", import.meta.url),
    "utf8",
  );
  assert.match(home, /lightsBlock/);
  assert.match(home, /light-events/);
  assert.match(analytics, /loadLightStats/);
  assert.match(analytics, /light-days/);
});

test("device detail combines signal, traffic and presence", () => {
  const detail = readFileSync(
    new URL("../../static/views/device-detail.js", import.meta.url),
    "utf8",
  );
  assert.match(detail, /openDeviceDetail/);
  assert.match(detail, /signalChart/);
  assert.match(detail, /getTraffic/);
  assert.match(devices, /device-open/);
  assert.match(home, /device-open/);
});

test("merged MAC can become primary", () => {
  assert.match(devices, /promote-btn/);
  assert.match(devices, /promoteDevice/);
});
