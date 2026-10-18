import { test } from "node:test";
import assert from "node:assert/strict";

import { eventText, nextLastId, selectNotifiable } from "../../static/views/settings.js";

const devices = [
  { mac: "aa:aa:aa:aa:aa:aa", name: "Телефон", person: "Иван", hidden: false },
  { mac: "bb:bb:bb:bb:bb:bb", name: "Ноутбук", person: "Анна", hidden: false },
  { mac: "cc:cc:cc:cc:cc:cc", name: null, person: null, hidden: false },
];

test("eventText names the person and device", () => {
  assert.equal(eventText({ mac: "aa:aa:aa:aa:aa:aa", type: "arrived" }, devices), "Иван: Телефон пришёл");
  assert.equal(eventText({ mac: "aa:aa:aa:aa:aa:aa", type: "left" }, devices), "Иван: Телефон ушёл");
});

test("eventText falls back to the mac for unknown devices", () => {
  assert.equal(eventText({ mac: "cc:cc:cc:cc:cc:cc", type: "arrived" }, devices), "cc:cc:cc:cc:cc:cc пришёл");
  assert.equal(eventText({ mac: "dd:dd:dd:dd:dd:dd", type: "left" }, devices), "dd:dd:dd:dd:dd:dd ушёл");
});

test("nextLastId keeps the current id when nothing is newer", () => {
  assert.equal(nextLastId([{ id: 3 }, { id: 7 }, { id: 5 }], 2), 7);
  assert.equal(nextLastId([], 2), 2);
  assert.equal(nextLastId([{ id: 1 }], 9), 9);
});

test("selectNotifiable filters by people and devices; empty filters mean all", () => {
  const events = [
    { id: 3, mac: "aa:aa:aa:aa:aa:aa" },
    { id: 4, mac: "bb:bb:bb:bb:bb:bb" },
    { id: 5, mac: "zz:zz:zz:zz:zz:zz" },
  ];
  const ids = (filters, lastId = 2) =>
    selectNotifiable(events, lastId, filters, devices).map((e) => e.id);

  assert.deepEqual(ids({ people: [], devices: [] }), [3, 4, 5]);
  assert.deepEqual(ids({ people: ["Иван"], devices: [] }), [3]);
  assert.deepEqual(ids({ people: [], devices: ["bb:bb:bb:bb:bb:bb"] }), [4]);
  assert.deepEqual(ids({ people: [], devices: [] }, 4), [5]);
});
