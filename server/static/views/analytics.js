/** Аналитика: тепловая карта, приходы/уходы, пончик, новые устройства, таймлайн, сигнал. */

import {
  getAnalytics,
  getAnomalies,
  getCalendar,
  getCompare,
  getLightStats,
  getRouterHistory,
  getSignal,
  getStats,
  getTimeMachine,
  getTraffic,
  getTimeline,
  getUptime,
} from "../api.js";
import {
  barsFromStats,
  deviceLabel,
  donutSegments,
  formatTraffic,
  formatDuration,
  heatmapGrid,
  hourlyBuckets,
  timelineSegments,
} from "../lib.js";
import {
  barChart,
  calendarHeat,
  donutChart,
  dualBarChart,
  heatmap,
  signalChart,
  timelineChart,
} from "../charts.js";

let stateRef = null;
let builtKey = null;
const loadTokens = new Map();

function beginLoad(name) {
  const token = (loadTokens.get(name) || 0) + 1;
  loadTokens.set(name, token);
  return token;
}

function isCurrentLoad(name, token) {
  return loadTokens.get(name) === token;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function isoDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() + "-" + month + "-" + day;
}

function options(items, selected) {
  return items
    .map(([value, label]) => {
      const isSel = value === selected ? " selected" : "";
      return '<option value="' + esc(value) + '"' + isSel + ">" + esc(label) + "</option>";
    })
    .join("");
}

function sampleLabel(value, { withDate = false } = {}) {
  const date =
    typeof value === "number" ? new Date(value * 1000) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  const format = withDate
    ? { day: "2-digit", month: "2-digit", hour: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" };
  return date.toLocaleString("ru-RU", format);
}

function trafficTopHtml(devices) {
  const top = devices
    .map((device) => ({
      device,
      bytes: (Number(device.rx_bytes) || 0) + (Number(device.tx_bytes) || 0),
    }))
    .filter((item) => item.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);
  if (!top.length) return '<p class="muted">Пока нет данных о трафике.</p>';
  return (
    '<div class="traffic-top-list">' +
    top
      .map(
        (item) =>
          '<div class="traffic-top-row"><span>' +
          esc(deviceLabel(item.device)) +
          "</span><strong>" +
          esc(formatTraffic(item.bytes)) +
          "</strong></div>",
      )
      .join("") +
    "</div>"
  );
}

function shell(people, devices) {
  const personItems = [["", "Все люди"]].concat(people.map((p) => [p.person, p.person]));
  const deviceItems = devices.map((device) => [device.mac, deviceLabel(device)]);
  const preferred = devices.find((device) => device.person || device.name) || devices[0];
  const trafficItems = devices
    .slice()
    .sort((a, b) => {
      const left = (Number(a.rx_bytes) || 0) + (Number(a.tx_bytes) || 0);
      const right = (Number(b.rx_bytes) || 0) + (Number(b.tx_bytes) || 0);
      return right - left;
    })
    .map((device) => [device.mac, deviceLabel(device)]);

  return (
    '<h2>Аналитика</h2>' +
    '<div class="analytics-grid">' +
    '<section class="panel wide">' +
    "<h3>Дом за неделю</h3>" +
    '<p class="muted">Сколько устройств было в сети в каждый час.</p>' +
    '<div class="heatmap-host"><p class="muted">Загрузка…</p></div>' +
    '<div class="heatmap-legend"><span>меньше</span>' +
    '<span class="heat-swatch level-1"></span><span class="heat-swatch level-2"></span>' +
    '<span class="heat-swatch level-3"></span><span class="heat-swatch level-4"></span>' +
    "<span>больше</span></div>" +
    "</section>" +
    '<section class="panel">' +
    "<h3>Приходы и уходы</h3>" +
    '<p class="muted">За 7 дней, по часам суток.</p>' +
    '<div class="hours-host"></div>' +
    '<div class="legend"><span class="legend-swatch bar-arrived"></span> пришли' +
    '<span class="legend-swatch bar-left"></span> ушли</div>' +
    "</section>" +
    '<section class="panel">' +
    "<h3>Кто в доме</h3>" +
    '<p class="muted">Устройства по людям.</p>' +
    '<div class="donut-host"></div>' +
    '<div class="donut-legend"></div>' +
    "</section>" +
    '<section class="panel">' +
    "<h3>Новые устройства</h3>" +
    '<p class="muted">По неделям, за 8 недель.</p>' +
    '<div class="new-host"></div>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>День человека</h3>" +
    '<div class="history-controls">' +
    '<label>Человек <select class="tl-person">' + options(personItems, "") + "</select></label>" +
    '<label>День <input type="date" class="tl-day" value="' + isoDay(new Date()) + '"></label>' +
    "</div>" +
    '<div class="timeline-host"></div>' +
    '<p class="muted tl-total"></p>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Сигнал Wi-Fi</h3>" +
    '<div class="history-controls">' +
    '<label>Устройство <select class="sig-mac">' + options(deviceItems, preferred ? preferred.mac : "") +
    "</select></label>" +
    '<label>Период <select class="sig-hours">' +
    options([["24", "24 часа"], ["72", "3 дня"], ["168", "7 дней"]], "24") +
    "</select></label>" +
    "</div>" +
    '<div class="signal-host"></div>' +
    '<p class="muted sig-hint"></p>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Связь с роутером</h3>" +
    '<p class="muted">Минуты в сутки, когда агент присылал данные.</p>' +
    '<div class="uptime-host"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Свет по комнатам</h3>" +
    '<p class="muted">Минуты, когда свет был включён, по минутным данным.</p>' +
    '<div class="history-controls">' +
    '<label>Период <select class="light-days">' +
    options([["7", "7 дней"], ["30", "30 дней"]], "7") +
    "</select></label>" +
    "</div>" +
    '<div class="light-stats-host"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Трафик устройств</h3>" +
    '<p class="muted">Скачано и отдано по данным nlbwmon; для Wi-Fi — резервно iwinfo.</p>' +
    '<div class="traffic-top">' +
    trafficTopHtml(devices) +
    "</div>" +
    '<div class="history-controls">' +
    '<label>Устройство <select class="traffic-mac">' +
    options(trafficItems, "") +
    "</select></label>" +
    '<label>Период <select class="traffic-hours">' +
    options(
      [
        ["6", "6 часов"],
        ["24", "24 часа"],
        ["72", "3 дня"],
      ],
      "24",
    ) +
    "</select></label>" +
    "</div>" +
    '<div class="traffic-host"><p class="muted">Выберите устройство.</p></div>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Нагрузка роутера</h3>" +
    '<div class="history-controls">' +
    '<label>Период <select class="router-days">' +
    options([["7", "7 дней"], ["30", "30 дней"]], "7") +
    "</select></label>" +
    "</div>" +
    '<div class="router-host"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Машина времени</h3>" +
    '<p class="muted">Кто был в сети в выбранный час.</p>' +
    '<div class="history-controls">' +
    '<label>День <input type="date" class="tm-date" value="' +
    isoDay(new Date()) +
    '"></label>' +
    '<label>Час <select class="tm-hour">' +
    options(
      Array.from({ length: 24 }, (_, hour) => [
        String(hour),
        String(hour).padStart(2, "0") + ":00",
      ]),
      String(new Date().getHours()),
    ) +
    "</select></label>" +
    "</div>" +
    '<div class="tm-host"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Календарь присутствия</h3>" +
    '<div class="history-controls">' +
    '<label>Месяц <input type="month" class="cal-month" value="' +
    isoDay(new Date()).slice(0, 7) +
    '"></label>' +
    '<label>Человек <select class="cal-person">' +
    options(personItems, "") +
    "</select></label>" +
    "</div>" +
    '<div class="calendar-host"></div>' +
    '<p class="muted cal-total"></p>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Сравнение недель</h3>" +
    '<p class="muted">Эта неделя против прошлой.</p>' +
    '<div class="compare-host"></div>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Итоги недели</h3>" +
    '<p class="muted">Часы дома, новые устройства и предупреждения.</p>' +
    '<div class="report-host"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    '<section class="panel wide">' +
    "<h3>Время дома по дням</h3>" +
    '<p class="muted">Суммарные часы всех устройств за 14 дней.</p>' +
    '<div class="days-host"></div>' +
    "</section>" +
    "</div>"
  );
}

async function loadOverview(root) {
  const host = root.querySelector(".heatmap-host");
  const token = beginLoad("overview");
  try {
    const data = await getAnalytics({ days: 7 });
    if (!isCurrentLoad("overview", token) || !host) return;

    host.innerHTML = "";
    heatmap(host, heatmapGrid(data.occupancy, data.now, 7));

    const hoursHost = root.querySelector(".hours-host");
    if (hoursHost) {
      hoursHost.innerHTML = "";
      dualBarChart(hoursHost, data.events_by_hour);
    }

    const newHost = root.querySelector(".new-host");
    if (newHost) {
      newHost.innerHTML = "";
      if (!data.new_devices || !data.new_devices.length) {
        newHost.innerHTML = '<p class="muted">Нет данных.</p>';
      } else {
        barChart(
          newHost,
          data.new_devices.map((row) => ({ label: row.week, value: row.count })),
          { height: 140 },
        );
      }
    }
  } catch (error) {
    if (!isCurrentLoad("overview", token)) return;
    if (host) host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

function loadDonut(root) {
  const counts = new Map();
  for (const device of (stateRef && stateRef.devices) || []) {
    if (device.hidden || device.state !== "home") continue;
    const key = device.person || "Без человека";
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const items = Array.from(counts, ([label, value]) => ({ label, value })).sort(
    (a, b) => b.value - a.value,
  );
  const host = root.querySelector(".donut-host");
  const legend = root.querySelector(".donut-legend");
  if (!host || !legend) return;

  host.innerHTML = "";
  legend.innerHTML = "";
  if (!items.length) {
    host.innerHTML = '<p class="muted">Сейчас дома никого нет.</p>';
    return;
  }

  const segments = donutSegments(items);
  donutChart(host, segments);
  legend.innerHTML = segments
    .map(
      (segment, index) =>
        '<span class="legend-item"><span class="legend-swatch c' + (index % 6) +
        '"></span>' + esc(segment.label) + " — " + segment.value + "</span>",
    )
    .join("");
}

function refreshTrafficTop(root) {
  const host = root.querySelector(".traffic-top");
  if (host) host.innerHTML = trafficTopHtml((stateRef && stateRef.devices) || []);
}

async function loadTimeline(root) {
  const personSelect = root.querySelector(".tl-person");
  const dayInput = root.querySelector(".tl-day");
  const host = root.querySelector(".timeline-host");
  const total = root.querySelector(".tl-total");
  if (!personSelect || !dayInput || !host) return;
  const token = beginLoad("timeline");

  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const data = await getTimeline({
      day: dayInput.value || undefined,
      person: personSelect.value || undefined,
    });
    if (!isCurrentLoad("timeline", token) || !host) return;
    host.innerHTML = "";
    const segments = timelineSegments(data.intervals, data.from, data.to);
    if (!segments.length) {
      host.innerHTML = '<p class="muted">В этот день данных нет.</p>';
      if (total) total.textContent = "";
      return;
    }
    timelineChart(host, segments);
    const minutes = segments.reduce(
      (sum, segment) => sum + Math.max(0, segment.to - segment.from),
      0,
    ) / 60;
    if (total) total.textContent = "Всего дома: " + formatDuration(minutes * 60) + ".";
  } catch (error) {
    if (!isCurrentLoad("timeline", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadSignal(root) {
  const macSelect = root.querySelector(".sig-mac");
  const hoursSelect = root.querySelector(".sig-hours");
  const host = root.querySelector(".signal-host");
  const hint = root.querySelector(".sig-hint");
  if (!macSelect || !host) return;
  const token = beginLoad("signal");

  if (!macSelect.value) {
    host.innerHTML = '<p class="muted">Нет устройств.</p>';
    return;
  }

  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const data = await getSignal({
      mac: macSelect.value,
      hours: Number(hoursSelect && hoursSelect.value) || 24,
    });
    if (!isCurrentLoad("signal", token)) return;
    const points = (data.points || []).filter((point) =>
      Number.isFinite(Number(point.signal)),
    );
    host.innerHTML = "";
    if (!points.length) {
      host.innerHTML =
        '<p class="muted">История появится после нескольких снимков агента (раз в 5 минут).</p>';
      if (hint) hint.textContent = "";
      return;
    }
    signalChart(host, points, data.from, data.to);
    if (hint) hint.textContent = "Точек: " + points.length + " · шкала −30…−95 dBm.";
  } catch (error) {
    if (!isCurrentLoad("signal", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadReport(root) {
  const host = root.querySelector(".report-host");
  if (!host) return;
  const token = beginLoad("report");
  try {
    const [compare, analytics, anomalies] = await Promise.all([
      getCompare({ days: 7 }),
      getAnalytics({ days: 7 }),
      getAnomalies(),
    ]);
    if (!isCurrentLoad("report", token) || !host) return;
    const newDevices = (analytics.new_devices || []).reduce(
      (sum, row) => sum + (Number(row.count) || 0),
      0,
    );
    const people = compare.people || [];
    const top = people[0];
    const items = [
      ["Дома за неделю", formatDuration((Number(compare.total) || 0) * 60)],
      ["Люди", String(people.length) + (top ? " · " + top.person : "")],
      ["Новые устройства", String(newDevices)],
      ["Аномалии", String((anomalies.items || []).length)],
    ];
    host.innerHTML =
      '<div class="report-grid">' +
      items
        .map(
          ([label, value]) =>
            '<div class="report-item"><span class="report-value">' +
            esc(value) +
            '</span><span class="report-label">' +
            esc(label) +
            "</span></div>",
        )
        .join("") +
      "</div>";
  } catch (error) {
    if (!isCurrentLoad("report", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadDays(root) {
  const host = root.querySelector(".days-host");
  if (!host) return;
  const token = beginLoad("days");
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 13);

  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const rows = await getStats({ group: "day", from: isoDay(from), to: isoDay(to) });
    if (!isCurrentLoad("days", token) || !host) return;
    const bars = barsFromStats(rows);
    host.innerHTML = "";
    if (!bars.length) {
      host.innerHTML = '<p class="muted">Нет данных.</p>';
      return;
    }
    barChart(host, bars, { height: 160 });
    const total = bars.reduce((sum, bar) => sum + bar.value, 0);
    host.insertAdjacentHTML(
      "beforeend",
      '<p class="muted">Всего за 14 дней: ' + formatDuration(total * 60) + ".</p>",
    );
  } catch (error) {
    if (!isCurrentLoad("days", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadCalendar(root) {
  const monthInput = root.querySelector(".cal-month");
  const personSelect = root.querySelector(".cal-person");
  const host = root.querySelector(".calendar-host");
  const total = root.querySelector(".cal-total");
  if (!host) return;
  const token = beginLoad("calendar");

  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const data = await getCalendar({
      month: (monthInput && monthInput.value) || undefined,
      person: (personSelect && personSelect.value) || undefined,
    });
    if (!isCurrentLoad("calendar", token) || !host) return;
    host.innerHTML = "";
    if (!data.days || !data.days.length) {
      host.innerHTML = '<p class="muted">Нет данных за этот месяц.</p>';
      if (total) total.textContent = "";
      return;
    }
    calendarHeat(host, data.days);
    if (total) {
      total.textContent =
        "Всего за месяц: " + formatDuration((data.total || 0) * 60) + ".";
    }
  } catch (error) {
    if (!isCurrentLoad("calendar", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadCompare(root) {
  const host = root.querySelector(".compare-host");
  if (!host) return;
  const token = beginLoad("compare");
  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const data = await getCompare({ days: 7 });
    if (!isCurrentLoad("compare", token) || !host) return;
    host.innerHTML = "";
    const rows = data.people || [];
    if (!rows.length) {
      host.innerHTML = '<p class="muted">Пока нет размеченных людей.</p>';
      return;
    }
    const parts = rows.map((item) => {
      const diff = (item.minutes || 0) - (item.prev_minutes || 0);
      const cls = diff > 0 ? " up" : diff < 0 ? " down" : "";
      const sign = diff > 0 ? "+" : diff < 0 ? "−" : "";
      return (
        '<div class="compare-row">' +
        '<span class="compare-name">' + esc(item.person) + "</span>" +
        '<span class="compare-now">' +
        formatDuration((item.minutes || 0) * 60) +
        "</span>" +
        '<span class="compare-prev">было ' +
        formatDuration((item.prev_minutes || 0) * 60) +
        "</span>" +
        '<span class="compare-diff' + cls + '">' +
        sign +
        formatDuration(Math.abs(diff) * 60) +
        "</span></div>"
      );
    });
    host.innerHTML = '<div class="compare-list">' + parts.join("") + "</div>";
    host.insertAdjacentHTML(
      "beforeend",
      '<p class="muted">Всего: ' +
        formatDuration((data.total || 0) * 60) +
        " · на прошлой неделе " +
        formatDuration((data.prev_total || 0) * 60) +
        ".</p>",
    );
  } catch (error) {
    if (!isCurrentLoad("compare", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadLightStats(root) {
  const host = root.querySelector(".light-stats-host");
  const select = root.querySelector(".light-days");
  if (!host) return;
  const token = beginLoad("light");
  const today = isoDay(new Date());

  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const days = select ? Number(select.value) || 7 : 7;
    const data = await getLightStats({ days });
    if (!isCurrentLoad("light", token)) return;
    const rooms = data.rooms || [];
    if (!rooms.length) {
      host.innerHTML =
        '<p class="muted">Нет данных о свете. Задайте тип «Светильник» и комнату устройствам.</p>';
      return;
    }
    const rows = rooms
      .map((room) => {
        const last = room.days && room.days.length ? room.days[room.days.length - 1] : null;
        const lastDate = last && last.date ? String(last.date) : "";
        const lastLabel =
          lastDate && lastDate !== today
            ? lastDate.slice(8) + "." + lastDate.slice(5, 7)
            : "сегодня";
        return (
          '<div class="light-stats-row"><span>' +
          esc(room.room || "Без комнаты") +
          '</span><span class="muted">' +
          formatDuration((Number(room.total) || 0) * 60) +
          '</span><span class="muted">' +
          esc(lastLabel) +
          " " +
          formatDuration((last ? Number(last.minutes) : 0) * 60) +
          "</span></div>"
        );
      })
      .join("");
    host.innerHTML =
      '<div class="light-stats">' + rows + "</div>" + '<div class="light-chart"></div>';
    barChart(
      host.querySelector(".light-chart"),
      rooms.map((room) => ({ label: room.room || "Без комнаты", value: room.total })),
      { height: 160, aria: "Минуты света по комнатам" },
    );
  } catch (error) {
    if (!isCurrentLoad("light", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadTrafficChart(root) {
  const macSelect = root.querySelector(".traffic-mac");
  const hoursSelect = root.querySelector(".traffic-hours");
  const host = root.querySelector(".traffic-host");
  if (!host || !macSelect) return;
  const token = beginLoad("traffic");
  const mac = macSelect.value;
  if (!mac) {
    host.innerHTML = '<p class="muted">Выберите устройство.</p>';
    return;
  }
  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const hours = Number(hoursSelect && hoursSelect.value) || 24;
    const data = await getTraffic({ mac, hours });
    if (!isCurrentLoad("traffic", token)) return;
    const buckets = hourlyBuckets(
      data.samples || [],
      (row) => (Number(row.rx_bytes) || 0) + (Number(row.tx_bytes) || 0),
    );
    if (!buckets.length) {
      host.innerHTML = '<p class="muted">Нет данных о трафике.</p>';
      return;
    }
    host.innerHTML = "";
    const timeOptions = { hour: "2-digit", minute: "2-digit" };
    if (hours > 24) {
      timeOptions.day = "2-digit";
      timeOptions.month = "2-digit";
    }
    barChart(
      host,
      buckets.map((row) => ({
        label: new Date(row.ts * 1000).toLocaleString("ru-RU", timeOptions),
        value: row.value,
      })),
      { height: 160, divisor: 1024, unit: "KiB", aria: "Трафик устройства" },
    );
  } catch (error) {
    if (!isCurrentLoad("traffic", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadRouter(root) {
  const host = root.querySelector(".router-host");
  if (!host) return;
  const token = beginLoad("router");
  const select = root.querySelector(".router-days");
  const days = select ? Number(select.value) || 7 : 7;
  try {
    const data = await getRouterHistory({ days });
    if (!isCurrentLoad("router", token)) return;
    const samples = data.samples || [];
    host.innerHTML = "";
    if (!samples.length) {
      host.innerHTML = '<p class="muted">Данных о роутере ещё нет.</p>';
      return;
    }
    barChart(
      host,
      samples.map((sample) => ({
        label: sampleLabel(sample.ts, { withDate: days > 7 }),
        value: Number(sample.mem_used) || 0,
      })),
      { height: 160, divisor: 1024, unit: "MiB", aria: "Память роутера" },
    );
  } catch (error) {
    if (!isCurrentLoad("router", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadUptime(root) {
  const host = root.querySelector(".uptime-host");
  if (!host) return;
  const token = beginLoad("uptime");
  try {
    const data = await getUptime({ days: 14 });
    if (!isCurrentLoad("uptime", token) || !host) return;
    const series = data.series || [];
    if (!series.length) {
      host.innerHTML = '<p class="muted">Агент ещё не выходил на связь.</p>';
      return;
    }
    host.innerHTML = "";
    const chart = document.createElement("div");
    host.appendChild(chart);
    barChart(
      chart,
      series.map((row) => ({ label: row.date, value: row.minutes })),
      { height: 160 },
    );
    const status = document.createElement("p");
    status.className = "muted";
    status.textContent = data.online
      ? "Сейчас на связи"
      : data.last_seen
        ? "Последний контакт: " + new Date(data.last_seen * 1000).toLocaleString("ru-RU")
        : "Контактов не было";
    host.appendChild(status);
  } catch (error) {
    if (!isCurrentLoad("uptime", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadTimeMachine(root) {
  const dateInput = root.querySelector(".tm-date");
  const hourInput = root.querySelector(".tm-hour");
  const host = root.querySelector(".tm-host");
  if (!host) return;
  const token = beginLoad("timemachine");

  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const data = await getTimeMachine({
      date: dateInput ? dateInput.value : undefined,
      hour: hourInput ? Number(hourInput.value) : undefined,
    });
    if (!isCurrentLoad("timemachine", token) || !host) return;
    host.innerHTML = "";
    const devices = data.devices || [];
    if (!devices.length) {
      host.innerHTML = '<p class="muted">В этот час в сети никого не было.</p>';
      return;
    }
    const people = Array.from(
      new Set(devices.filter((d) => d.person && !d.hidden).map((d) => d.person)),
    );
    const head = people.length
      ? '<p class="tm-people">Дома: <strong>' + people.map(esc).join(", ") + "</strong></p>"
      : "";
    host.innerHTML =
      head +
      '<ul class="tm-devices">' +
      devices
        .map(
          (d) =>
            "<li>" + esc(deviceLabel(d)) + ' <span class="sub mac">' + esc(d.mac) + "</span></li>",
        )
        .join("") +
      "</ul>";
  } catch (error) {
    if (!isCurrentLoad("timemachine", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

function onChange(root, event) {
  const target = event.target;
  if (!target) return;
  if (target.classList.contains("light-days")) {
    loadLightStats(root);
    return;
  }
  if (
    target.classList.contains("traffic-mac") ||
    target.classList.contains("traffic-hours")
  ) {
    loadTrafficChart(root);
    return;
  }
  if (target.classList.contains("router-days")) {
    loadRouter(root);
    return;
  }
  if (target.classList.contains("tm-date") || target.classList.contains("tm-hour")) {
    loadTimeMachine(root);
    return;
  }
  if (
    target.classList.contains("cal-month") ||
    target.classList.contains("cal-person")
  ) {
    loadCalendar(root);
  } else if (target.classList.contains("tl-person") || target.classList.contains("tl-day")) {
    loadTimeline(root);
  } else if (
    target.classList.contains("sig-mac") ||
    target.classList.contains("sig-hours")
  ) {
    loadSignal(root);
  }
}

export function render(root, state) {
  stateRef = state;
  const people = state.people || [];
  const devices = state.devices || [];
  const key =
    people.map((person) => person.person).join("|") +
    "#" +
    devices.map((device) => device.mac).join("|");

  if (root.querySelector(".analytics-grid") && builtKey === key) {
    loadDonut(root);
    refreshTrafficTop(root);
    return;
  }
  builtKey = key;

  root.innerHTML = shell(people, devices);
  root.onchange = (event) => onChange(root, event);
  loadOverview(root);
  loadDonut(root);
  loadTimeline(root);
  loadSignal(root);
  loadTimeMachine(root);
  loadUptime(root);
  loadRouter(root);
  loadTrafficChart(root);
  loadLightStats(root);
  loadCalendar(root);
  loadCompare(root);
  loadReport(root);
  loadDays(root);
}
