/** Столбчатая SVG-диаграмма без внешних библиотек. */

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Чистая раскладка столбцов: считает максимум и координаты каждого столбца
 * в системе координат viewBox (ось Y — вниз, столбцы растут от `height`).
 */
export function computeBarLayout(bars, { width = 600, height = 180, gap = 4 } = {}) {
  const counts = bars.map((b) => Number(b.value) || 0);
  const maxValue = counts.reduce((max, value) => Math.max(max, value), 0);
  const count = bars.length;
  const slot = count ? (width - gap * (count - 1)) / count : 0;
  return {
    maxValue,
    bars: bars.map((bar, index) => {
      const value = counts[index];
      const barHeight = maxValue > 0 ? (value / maxValue) * height : 0;
      return {
        label: String(bar.label),
        value,
        x: index * (slot + gap),
        y: height - barHeight,
        width: slot,
        height: barHeight,
      };
    }),
  };
}

/** Подпись оси: дата «2026-10-14» → «14.10», неделя «2026-W42» → «W42». */
function shortLabel(label) {
  const week = /^\d{4}-W(\d{1,2})$/.exec(label);
  if (week) return "W" + week[1];
  const day = /^\d{4}-(\d{2})-(\d{2})$/.exec(label);
  if (day) return day[2] + "." + day[1];
  return label;
}

/**
 * Добавляет SVG-диаграмму в конец `root`. Подписи прореживаются, чтобы
 * столбцов с текстом было не больше `maxLabels`.
 */
export function barChart(
  root,
  bars,
  { width = 640, height = 180, maxLabels = 12, divisor = 60, unit = "ч", aria = "Часы онлайн по периодам" } = {},
) {
  const layout = computeBarLayout(bars, { width, height });
  const step = layout.bars.length > maxLabels ? Math.ceil(layout.bars.length / maxLabels) : 1;
  const parts = [
    '<svg class="bar-chart" viewBox="0 0 ' + width + " " + (height + 30) +
      '" role="img" aria-label="' + esc(aria) + '">',
    '<line class="axis" x1="0" y1="' + height + '" x2="' + width + '" y2="' + height + '"></line>',
  ];
  layout.bars.forEach((bar, index) => {
    const visible = bar.value > 0 ? Math.max(bar.height, 1) : 0;
    const y = height - visible;
    const amount = (bar.value / divisor).toFixed(1).replace(/\.0$/, "");
    parts.push(
      '<rect class="bar" x="' + round(bar.x) + '" y="' + round(y) +
        '" width="' + round(bar.width) + '" height="' + round(visible) + '">' +
        "<title>" + esc(bar.label) + ": " + amount + (unit ? " " + esc(unit) : "") +
        "</title></rect>",
    );
    if (index % step === 0) {
      parts.push(
        '<text class="bar-label" x="' + round(bar.x + bar.width / 2) +
          '" y="' + (height + 18) + '" text-anchor="middle">' +
          esc(shortLabel(bar.label)) + "</text>",
      );
    }
  });
  parts.push("</svg>");
  root.insertAdjacentHTML("beforeend", parts.join(""));
}

/** Искра присутствия: 24 столбика по часам (минуты 0..60). */
export function sparkline(values, { width = 96, height = 22, max = 60 } = {}) {
  const list = values && values.length ? values : [];
  const count = Math.max(1, list.length);
  const slot = width / count;
  const barWidth = Math.max(1, slot * 0.72);
  const parts = [
    '<svg class="sparkline" viewBox="0 0 ' + width + " " + height +
      '" preserveAspectRatio="none" role="img" aria-label="Присутствие за сутки">',
  ];
  list.forEach((value, index) => {
    const minutes = Math.max(0, Math.min(max, Number(value) || 0));
    const barHeight = (minutes / max) * height;
    parts.push(
      '<rect class="spark-bar' + (minutes > 0 ? "" : " is-empty") +
        '" x="' + round(index * slot) + '" y="' + round(height - barHeight) +
        '" width="' + round(barWidth) + '" height="' + round(Math.max(0.5, barHeight)) +
        '"><title>' + String(index).padStart(2, "0") + ":00 — " + minutes + " мин</title></rect>",
    );
  });
  parts.push("</svg>");
  return parts.join("");
}

/** Тепловая карта «дни × часы». `grid` — из `heatmapGrid()`. */
export function heatmap(root, grid) {
  const max = Math.max(1, Number(grid && grid.max) || 0);
  const parts = ['<div class="heatmap">'];
  parts.push(
    '<div class="heatmap-row heatmap-head"><span class="heatmap-day"></span>' +
      '<div class="heatmap-cells">',
  );
  for (let hour = 0; hour < 24; hour += 1) {
    parts.push('<span class="heat-hour">' + (hour % 3 === 0 ? hour : "") + "</span>");
  }
  parts.push("</div></div>");

  for (const row of (grid && grid.rows) || []) {
    parts.push(
      '<div class="heatmap-row"><span class="heatmap-day">' + esc(row.label) +
        '</span><div class="heatmap-cells">',
    );
    for (const cell of row.cells) {
      const level = cell.value > 0 ? Math.min(4, Math.ceil((cell.value / max) * 4)) : 0;
      const title =
        row.date + " " + String(cell.hour).padStart(2, "0") + ":00 — " +
        cell.value + " устр.";
      parts.push(
        '<span class="heat-cell level-' + level + '" title="' + esc(title) + '"></span>',
      );
    }
    parts.push("</div></div>");
  }
  parts.push("</div>");
  root.insertAdjacentHTML("beforeend", parts.join(""));
}

function clock(ts) {
  const date = new Date(Number(ts) * 1000);
  return (
    String(date.getHours()).padStart(2, "0") +
    ":" +
    String(date.getMinutes()).padStart(2, "0")
  );
}

/** Полоса дня: интервалы присутствия в процентах. */
export function timelineChart(root, segments) {
  const parts = ['<div class="timeline"><div class="timeline-track">'];
  for (const segment of segments || []) {
    const title = clock(segment.from) + "–" + clock(segment.to);
    parts.push(
      '<span class="timeline-seg" style="left:' + round(segment.left) +
        "%;width:" + round(segment.width) + '%" title="' + esc(title) + '"></span>',
    );
  }
  parts.push('</div><div class="timeline-hours">');
  for (const hour of ["00", "06", "12", "18", "24"]) {
    parts.push("<span>" + hour + "</span>");
  }
  parts.push("</div></div>");
  root.insertAdjacentHTML("beforeend", parts.join(""));
}

/** Пончик по долям (сегменты из `donutSegments()`). */
export function donutChart(root, segments, { size = 180 } = {}) {
  const radius = 60;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const parts = [
    '<svg class="donut" viewBox="0 0 ' + size + " " + size +
      '" role="img" aria-label="Распределение устройств">',
    '<circle class="donut-bg" cx="' + center + '" cy="' + center + '" r="' + radius +
      '" fill="none" stroke-width="22"></circle>',
  ];
  (segments || []).forEach((segment, index) => {
    if (segment.share <= 0) return;
    const dash = segment.share * circumference;
    parts.push(
      '<circle class="donut-seg c' + (index % 6) + '" cx="' + center +
        '" cy="' + center + '" r="' + radius + '" fill="none" stroke-width="22"' +
        ' stroke-dasharray="' + round(dash) + " " + round(circumference - dash) + '"' +
        ' stroke-dashoffset="' + round(-segment.offset * circumference) + '"' +
        ' transform="rotate(-90 ' + center + " " + center + ')">' +
        "<title>" + esc(segment.label) + ": " + segment.value + "</title></circle>",
    );
  });
  parts.push("</svg>");
  root.insertAdjacentHTML("beforeend", parts.join(""));
}

/** Парные столбцы: приходы и уходы по 24 часам. */
export function dualBarChart(root, rows, { width = 640, height = 150 } = {}) {
  const source = rows || [];
  const list = Array.from({ length: 24 }, (_, hour) => {
    const found = source.find((row) => Number(row.hour) === hour) || {};
    return {
      hour,
      arrived: Number(found.arrived) || 0,
      left: Number(found.left) || 0,
    };
  });
  const max = list.reduce((value, row) => Math.max(value, row.arrived, row.left), 1);
  const slot = width / 24;
  const barWidth = slot * 0.32;
  const parts = [
    '<svg class="dual-chart" viewBox="0 0 ' + width + " " + (height + 26) +
      '" role="img" aria-label="Приходы и уходы по часам">',
    '<line class="axis" x1="0" y1="' + height + '" x2="' + width + '" y2="' + height + '"></line>',
  ];
  list.forEach((row) => {
    const x = row.hour * slot;
    const arrivedHeight = (row.arrived / max) * height;
    const leftHeight = (row.left / max) * height;
    parts.push(
      '<rect class="bar-arrived" x="' + round(x + slot * 0.16) + '" y="' +
        round(height - arrivedHeight) + '" width="' + round(barWidth) + '" height="' +
        round(arrivedHeight) + '"><title>' + row.hour + ":00 — пришли: " + row.arrived +
        "</title></rect>",
      '<rect class="bar-left" x="' + round(x + slot * 0.52) + '" y="' +
        round(height - leftHeight) + '" width="' + round(barWidth) + '" height="' +
        round(leftHeight) + '"><title>' + row.hour + ":00 — ушли: " + row.left +
        "</title></rect>",
    );
    if (row.hour % 3 === 0) {
      parts.push(
        '<text class="bar-label" x="' + round(x + slot / 2) + '" y="' + (height + 18) +
          '" text-anchor="middle">' + row.hour + "</text>",
      );
    }
  });
  parts.push("</svg>");
  root.insertAdjacentHTML("beforeend", parts.join(""));
}

/** График сигнала Wi-Fi: сверху −30 dBm, снизу −95 dBm. */
export function signalChart(root, points, from, to, { width = 640, height = 150 } = {}) {
  const top = -30;
  const bottom = -95;
  const span = Math.max(1, Number(to) - Number(from));
  const x = (ts) => ((Number(ts) - Number(from)) / span) * width;
  const y = (value) =>
    ((top - Math.max(bottom, Math.min(top, Number(value)))) / (top - bottom)) * height;
  const list = points || [];

  const parts = [
    '<svg class="signal-chart" viewBox="0 0 ' + width + " " + (height + 26) +
      '" role="img" aria-label="Сигнал Wi-Fi">',
  ];
  for (const level of [-50, -65, -75]) {
    parts.push(
      '<line class="signal-grid" x1="0" y1="' + round(y(level)) + '" x2="' + width +
        '" y2="' + round(y(level)) + '"></line>',
      '<text class="signal-label" x="4" y="' + round(y(level) - 4) + '">' +
        level + "</text>",
    );
  }
  if (list.length) {
    parts.push(
      '<polyline class="signal-line" points="' +
        list.map((point) => round(x(point.ts)) + "," + round(y(point.signal))).join(" ") +
        '"></polyline>',
    );
  }
  if (list.length <= 60) {
    for (const point of list) {
      parts.push(
        '<circle class="signal-dot" cx="' + round(x(point.ts)) + '" cy="' +
          round(y(point.signal)) + '" r="2.2"><title>' + clock(point.ts) + " — " +
          point.signal + " dBm</title></circle>",
      );
    }
  }
  parts.push("</svg>");
  root.insertAdjacentHTML("beforeend", parts.join(""));
}

const CAL_WEEK = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function minutesLabel(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (!hours) return rest + " мин";
  return rest ? hours + " ч " + rest + " мин" : hours + " ч";
}

/** Календарь-теплокарта месяца: 7 колонок, цвет — часы дома. */
export function calendarHeat(root, days, { max } = {}) {
  const list = (days || []).filter((day) => day && day.date);
  if (!list.length) {
    root.insertAdjacentHTML("beforeend", '<p class="muted">Нет данных.</p>');
    return;
  }

  const values = list.map((day) => Math.max(0, Number(day.minutes) || 0));
  const top = Math.max(1, Number(max) || Math.max(...values));
  const first = new Date(list[0].date + "T00:00:00");
  const offset = Number.isNaN(first.getTime()) ? 0 : (first.getDay() + 6) % 7;

  const cells = [];
  for (let index = 0; index < offset; index += 1) {
    cells.push('<span class="cal-cell is-empty"></span>');
  }
  for (const day of list) {
    const value = Math.max(0, Number(day.minutes) || 0);
    const level = value ? Math.min(4, Math.max(1, Math.ceil((value / top) * 4))) : 0;
    const number = Number(String(day.date).slice(8));
    cells.push(
      '<span class="cal-cell level-' + level + '" title="' + esc(day.date) + " — " +
        esc(minutesLabel(value)) + '"><span class="cal-day">' + esc(number) + "</span></span>",
    );
  }

  const head = CAL_WEEK.map((name) => "<span>" + name + "</span>").join("");
  root.insertAdjacentHTML(
    "beforeend",
    '<div class="calendar"><div class="cal-week">' + head + '</div>' +
      '<div class="cal-grid">' + cells.join("") + "</div></div>",
  );
}
