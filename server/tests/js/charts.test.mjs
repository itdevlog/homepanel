import { test } from "node:test";
import assert from "node:assert/strict";

import { computeBarLayout } from "../../static/charts.js";

test("computeBarLayout масштабирует столбцы по максимуму", () => {
  const layout = computeBarLayout(
    [
      { label: "a", value: 90 },
      { label: "b", value: 30 },
    ],
    { width: 200, height: 100, gap: 0 },
  );
  assert.equal(layout.maxValue, 90);
  assert.equal(layout.bars.length, 2);
  assert.equal(layout.bars[0].width, 100);
  assert.equal(layout.bars[0].height, 100);
  assert.equal(layout.bars[0].y, 0);
  assert.equal(Math.round(layout.bars[1].height), 33);
  assert.equal(Math.round(layout.bars[1].y), 67);
});

test("computeBarLayout не делится на ноль", () => {
  assert.deepEqual(computeBarLayout([], { width: 200, height: 100 }).bars, []);
  const zero = computeBarLayout([{ label: "a", value: 0 }], { width: 200, height: 100 });
  assert.equal(zero.maxValue, 0);
  assert.equal(zero.bars[0].height, 0);
});
