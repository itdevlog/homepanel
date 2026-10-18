import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  groupPeople,
  diffEvents,
  barsFromStats,
  isUnidentified,
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
