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
export function barChart(root, bars, { width = 640, height = 180, maxLabels = 12 } = {}) {
  const layout = computeBarLayout(bars, { width, height });
  const step = layout.bars.length > maxLabels ? Math.ceil(layout.bars.length / maxLabels) : 1;
  const parts = [
    '<svg class="bar-chart" viewBox="0 0 ' + width + " " + (height + 30) +
      '" role="img" aria-label="Часы онлайн по периодам">',
    '<line class="axis" x1="0" y1="' + height + '" x2="' + width + '" y2="' + height + '"></line>',
  ];
  layout.bars.forEach((bar, index) => {
    const visible = bar.value > 0 ? Math.max(bar.height, 1) : 0;
    const y = height - visible;
    const hours = (bar.value / 60).toFixed(1).replace(/\.0$/, "");
    parts.push(
      '<rect class="bar" x="' + round(bar.x) + '" y="' + round(y) +
        '" width="' + round(bar.width) + '" height="' + round(visible) + '">' +
        "<title>" + esc(bar.label) + ": " + hours + " ч</title></rect>",
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
