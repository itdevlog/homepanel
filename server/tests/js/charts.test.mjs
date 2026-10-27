import { test } from "node:test";
import assert from "node:assert/strict";

import {
  barChart,
  computeBarLayout,
  donutChart,
  signalChart,
} from "../../static/charts.js";
import { formatTraffic } from "../../static/lib.js";

function chartRoot() {
  return {
    html: "",
    insertAdjacentHTML(_position, html) {
      this.html += html;
    },
  };
}

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

test("computeBarLayout не даёт отрицательных столбцов на длинных сериях", () => {
  const bars = Array.from({ length: 864 }, (_, index) => ({
    label: String(index),
    value: index + 1,
  }));
  const layout = computeBarLayout(bars, { width: 594, height: 180, gap: 4 });
  for (const bar of layout.bars) {
    assert.ok(bar.width > 0, "ширина должна быть положительной");
    assert.ok(bar.x >= 0, "x не должен быть отрицательным");
    assert.ok(bar.x + bar.width <= 594 + 1e-9, "столбец не должен выходить за ширину");
  }
});

test("barChart подписывает трафик в МБ/ГБ через valueFormatter", () => {
  const root = chartRoot();
  barChart(root, [{ label: "12:00", value: 1.5 * 1024 ** 3 }], {
    width: 320,
    valueFormatter: formatTraffic,
  });
  assert.match(root.html, /1,5 ГБ/);
  assert.doesNotMatch(root.html, /KiB/);
});

test("signalChart подписывает уровни сигнала по-русски", () => {
  const root = chartRoot();
  signalChart(root, [], 0, 3600, { width: 320 });
  assert.match(root.html, /хороший/);
  assert.match(root.html, /слабый/);
});

test("signalChart не соединяет точки через большой перерыв", () => {
  const root = chartRoot();
  signalChart(
    root,
    [
      { ts: 0, signal: -40 },
      { ts: 300, signal: -45 },
      { ts: 1800, signal: -60 },
    ],
    0,
    3600,
    { width: 320 },
  );
  assert.equal((root.html.match(/<polyline/g) || []).length, 2);
  assert.equal((root.html.match(/signal-area/g) || []).length, 2);
});

test("donutChart показывает сумму в центре", () => {
  const root = chartRoot();
  donutChart(root, [{ label: "Дома", value: 3, share: 0.6, offset: 0 }]);
  assert.match(root.html, /donut-total/);
  assert.match(root.html, />3</);
});
