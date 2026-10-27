import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsQuery } from "../../static/api.js";

// Раньше getEvents всегда отправлял since (null -> 0), а сервер при since=0
// отдаёт САМЫЕ СТАРЫЕ события — первое включение уведомлений давало всплеск
// устаревших уведомлений. Теперь since опускается, если он не задан.
test("eventsQuery omits since when null and adds limit when given", () => {
  assert.equal(eventsQuery(0, 200), "since=0&limit=200");
  assert.equal(eventsQuery(12, null), "since=12");
  assert.equal(eventsQuery(null, 1), "limit=1");
  assert.equal(eventsQuery(undefined), "");
});

test("eventsQuery adds period and cursor filters", () => {
  assert.equal(
    eventsQuery(null, 500, { from: 100, to: 200, before: 50 }),
    "limit=500&from=100&to=200&before=50",
  );
});
