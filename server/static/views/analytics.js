/** Аналитика: тепловая карта, приходы/уходы, пончик, новые устройства, таймлайн, сигнал. */

import {
  getAnalytics,
  getLightStats,
  getRouterHistory,
  getSignal,
  getTimeMachine,
  getTrafficTable,
  getTimeline,
  getUptime,
} from "../api.js";
import {
  deviceLabel,
  formatTraffic,
  formatDuration,
  heatmapGrid,
  timelineSegments,
} from "../lib.js";
import {
  barChart,
  dualBarChart,
  heatmap,
  signalChart,
  timelineChart,
} from "../charts.js";
import { icon } from "../icons.js";

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

function homePeopleHtml(devices) {
  const counts = new Map();
  const names = new Map();
  for (const device of devices || []) {
    if (device.hidden || device.state !== "home" || !device.person) continue;
    const person = device.person;
    counts.set(person, (counts.get(person) || 0) + 1);
    if (!names.has(person)) names.set(person, []);
    names.get(person).push(deviceLabel(device));
  }
  const items = Array.from(counts, ([person, count]) => ({ person, count })).sort(
    (a, b) => b.count - a.count,
  );
  if (!items.length) return '<p class="muted">Сейчас дома никого нет.</p>';
  return (
    '<div class="home-people-list">' +
    items
      .map(
        (item) =>
          '<div class="home-people-row"><span class="home-people-name">' +
          esc(item.person) +
          '</span><span class="home-people-count">' +
          item.count +
          "</span></div>" +
          '<div class="home-people-devices muted">' +
          esc((names.get(item.person) || []).join(", ")) +
          "</div>",
      )
      .join("") +
    "</div>"
  );
}

function newDevicesHtml(rows) {
  if (!rows || !rows.length) return '<p class="muted">Нет данных.</p>';
  const total = rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  return (
    '<div class="new-devices-list">' +
    rows
      .map(
        (row) =>
          '<div class="new-devices-row"><span>' +
          esc(row.week || "—") +
          '</span><strong>' +
          (Number(row.count) || 0) +
          "</strong></div>",
      )
      .join("") +
    '<p class="muted">Всего за 8 недель: ' +
    total +
    ".</p></div>"
  );
}

function trafficTableHtml(rows, devices, source) {
  if (!rows || !rows.length) {
    return '<p class="muted">За выбранный период трафика нет.</p>';
  }
  const byMac = new Map((devices || []).map((device) => [device.mac, device]));
  const body = rows
    .map((row) => {
      const device = byMac.get(row.mac);
      return (
        '<tr><td data-label="Устройство"><span class="dev-label">' +
        esc(device ? deviceLabel(device) : row.mac) +
        "</span></td>" +
        '<td data-label="Скачано">' +
        esc(formatTraffic(row.rx_bytes)) +
        "</td>" +
        '<td data-label="Отдано">' +
        esc(formatTraffic(row.tx_bytes)) +
        "</td>" +
        '<td data-label="Всего"><strong>' +
        esc(formatTraffic(row.total)) +
        "</strong></td></tr>"
      );
    })
    .join("");
  return (
    '<div class="table-wrap"><table class="device-table traffic-table">' +
    "<thead><tr><th>Устройство</th><th>Скачано</th><th>Отдано</th><th>Всего</th></tr></thead>" +
    "<tbody>" + body + "</tbody></table></div>" +
    '<p class="muted">Источник: ' +
    (source === "nlbw" ? "nlbwmon" : "Wi-Fi (iwinfo)") +
    ".</p>"
  );
}

function shell(people, devices) {
  const deviceItems = devices.map((device) => [device.mac, deviceLabel(device)]);
  const preferred = devices.find((device) => device.person || device.name) || devices[0];

  return (
    '<section class="page analytics-page">' +
    '<header class="page-head"><div><p class="eyebrow">Наблюдения</p><h1>Аналитика</h1>' +
    '<p class="page-sub">Ритм дома, активность людей и состояние сети за неделю.</p></div></header>' +
    '<nav class="tabbar" aria-label="Разделы аналитики">' +
    '<button type="button" class="tab is-active" data-analytics-tab="overview">' + icon("analytics") + "Обзор</button>" +
    '<button type="button" class="tab" data-analytics-tab="people">' + icon("users") + "Люди</button>" +
    '<button type="button" class="tab" data-analytics-tab="network">' + icon("wifi") + "Сеть</button>" +
    '<button type="button" class="tab" data-analytics-tab="light">' + icon("light") + "Свет</button>" +
    "</nav>" +
    '<div class="analytics-grid" data-tab="overview">' +
    '<section class="panel wide" data-section="overview" data-overview="heat">' +
    '<div class="panel-head"><div><h3>Дом за неделю</h3>' +
    '<p class="muted">Сколько устройств было в сети в каждый час.</p></div>' +
    '<span class="panel-icon">' + icon("calendar") + "</span></div>" +
    '<div class="heatmap-host"><p class="muted">Загрузка…</p></div>' +
    '<div class="heatmap-legend"><span>меньше</span>' +
    '<span class="heat-swatch level-1"></span><span class="heat-swatch level-2"></span>' +
    '<span class="heat-swatch level-3"></span><span class="heat-swatch level-4"></span>' +
    "<span>больше</span></div>" +
    "</section>" +
    '<section class="panel" data-section="overview" data-overview="arrivals">' +
    '<div class="panel-head"><div><h3>Приходы и уходы</h3>' +
    '<p class="muted">За 7 дней, по часам суток.</p></div></div>' +
    '<div class="hours-host"></div>' +
    '<div class="legend"><span class="legend-swatch bar-arrived"></span> пришли' +
    '<span class="legend-swatch bar-left"></span> ушли</div>' +
    "</section>" +
    '<section class="panel" data-section="overview" data-overview="who">' +
    '<div class="panel-head"><div><h3>Кто в доме</h3>' +
    '<p class="muted">Сейчас дома, по людям.</p></div></div>' +
    '<div class="home-people-host"></div>' +
    "</section>" +
    '<section class="panel" data-section="overview" data-overview="new">' +
    '<div class="panel-head"><div><h3>Новые устройства</h3>' +
    '<p class="muted">По неделям, за 8 недель.</p></div></div>' +
    '<div class="new-host"></div>' +
    "</section>" +
    '<section class="panel wide" data-section="people">' +
    '<div class="panel-head"><div><h3>День человека</h3>' +
    '<p class="muted">Присутствие каждого жильца в течение дня.</p></div>' +
    '<span class="panel-icon">' + icon("users") + "</span></div>" +
    '<div class="chart-controls">' +
    '<label class="filter-field compact"><span>День</span><input type="date" class="tl-day" value="' + isoDay(new Date()) + '"></label>' +
    "</div>" +
    '<div class="timeline-people"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    '<section class="panel wide" data-section="people">' +
    '<div class="panel-head"><div><h3>Машина времени</h3>' +
    '<p class="muted">Кто был в сети в выбранный час.</p></div>' +
    '<span class="panel-icon">' + icon("clock") + "</span></div>" +
    '<div class="chart-controls">' +
    '<label class="filter-field compact"><span>День</span><input type="date" class="tm-date" value="' +
    isoDay(new Date()) + '"></label>' +
    '<label class="filter-field compact"><span>Час</span><select class="tm-hour">' +
    options(
      Array.from({ length: 24 }, (_, hour) => [
        String(hour),
        String(hour).padStart(2, "0") + ":00",
      ]),
      String(new Date().getHours()),
    ) +
    "</select></label></div>" +
    '<div class="tm-host"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    '<section class="panel wide" data-section="network">' +
    '<div class="panel-head"><div><h3>Сигнал Wi-Fi</h3>' +
    '<p class="muted">Качество соединения выбранного устройства.</p></div>' +
    '<span class="panel-icon">' + icon("signal") + "</span></div>" +
    '<div class="chart-controls">' +
    '<label class="filter-field compact"><span>Устройство</span><select class="sig-mac">' +
    options(deviceItems, preferred ? preferred.mac : "") + "</select></label>" +
    '<label class="filter-field compact"><span>Период</span><select class="sig-hours">' +
    options([["24", "24 часа"], ["72", "3 дня"], ["168", "7 дней"]], "24") +
    "</select></label></div>" +
    '<div class="signal-host"></div>' +
    '<p class="muted sig-hint"></p>' +
    "</section>" +
    '<section class="panel wide" data-section="network">' +
    '<div class="panel-head"><div><h3>Связь с роутером</h3>' +
    '<p class="muted">Минуты в сутки, когда агент присылал данные.</p></div>' +
    '<span class="panel-icon">' + icon("wifi") + "</span></div>" +
    '<div class="uptime-host"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    '<section class="panel wide" data-section="network">' +
    '<div class="panel-head"><div><h3>Трафик устройств</h3>' +
    '<p class="muted">Скачано и отдано за период по всем устройствам.</p></div>' +
    '<span class="panel-icon">' + icon("download") + "</span></div>" +
    '<div class="chart-controls">' +
    '<label class="filter-field compact"><span>Период</span><select class="traffic-hours">' +
    options(
      [["6", "6 часов"], ["24", "24 часа"], ["72", "3 дня"], ["168", "7 дней"], ["720", "30 дней"]],
      "24",
    ) +
    "</select></label></div>" +
    '<div class="traffic-table-host"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    '<section class="panel wide" data-section="network">' +
    '<div class="panel-head"><div><h3>Нагрузка роутера</h3>' +
    '<p class="muted">Load average (1 мин) и использование памяти.</p></div>' +
    '<span class="panel-icon">' + icon("router") + "</span></div>" +
    '<div class="chart-controls">' +
    '<label class="filter-field compact"><span>Период</span><select class="router-days">' +
    options([["7", "7 дней"], ["30", "30 дней"]], "7") +
    "</select></label></div>" +
    '<div class="router-host"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    '<section class="panel wide light-panel" data-section="light">' +
    '<div class="panel-head"><div><h3>Свет по комнатам</h3>' +
    '<p class="muted">Минуты, когда свет был включён, по минутным данным.</p></div>' +
    '<span class="panel-icon">' + icon("light") + "</span></div>" +
    '<div class="chart-controls">' +
    '<label class="filter-field compact"><span>Период</span><select class="light-days">' +
    options([["7", "7 дней"], ["30", "30 дней"]], "7") +
    "</select></label></div>" +
    '<div class="light-stats-host"><p class="muted">Загрузка…</p></div>' +
    "</section>" +
    "</div></section>"
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
    if (newHost) newHost.innerHTML = newDevicesHtml(data.new_devices);
  } catch (error) {
    if (!isCurrentLoad("overview", token)) return;
    if (host) host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

function loadHomePeople(root) {
  const host = root.querySelector(".home-people-host");
  if (!host) return;
  host.innerHTML = homePeopleHtml((stateRef && stateRef.devices) || []);
}

async function loadTimeline(root) {
  const dayInput = root.querySelector(".tl-day");
  const host = root.querySelector(".timeline-people");
  if (!dayInput || !host) return;
  const token = beginLoad("timeline");
  const people = ((stateRef && stateRef.people) || [])
    .map((person) => person.person)
    .filter(Boolean);
  if (!people.length) {
    host.innerHTML = '<p class="muted">Люди ещё не размечены.</p>';
    return;
  }

  host.innerHTML = '<p class="muted">Загрузка…</p>';
  const results = await Promise.all(
    people.map(async (person) => {
      try {
        const data = await getTimeline({
          day: dayInput.value || undefined,
          person,
        });
        return { person, data };
      } catch (error) {
        return { person, error };
      }
    }),
  );
  if (!isCurrentLoad("timeline", token) || !host) return;

  host.innerHTML = results
    .map((result, index) => {
      if (result.error) {
        return (
          '<div class="timeline-person" data-person-index="' + index + '">' +
          '<div class="timeline-person-head"><strong>' + esc(result.person) +
          '</strong><span class="muted">ошибка</span></div>' +
          '<p class="error">' + esc(result.error.message) + "</p></div>"
        );
      }
      const data = result.data || {};
      const segments = timelineSegments(data.intervals || [], data.from, data.to);
      const minutes = segments.reduce(
        (sum, segment) => sum + Math.max(0, segment.to - segment.from),
        0,
      ) / 60;
      return (
        '<div class="timeline-person" data-person-index="' + index + '">' +
        '<div class="timeline-person-head"><strong>' + esc(result.person) +
        "</strong><span class=\"muted\">" +
        (segments.length ? formatDuration(minutes * 60) : "нет данных") +
        "</span></div>" +
        (segments.length
          ? '<div class="timeline-row-host"></div>'
          : '<p class="muted">В этот день данных нет.</p>') +
        "</div>"
      );
    })
    .join("");

  results.forEach((result, index) => {
    const data = result.data;
    if (!data) return;
    const row = host.querySelector('[data-person-index="' + index + '"] .timeline-row-host');
    if (!row) return;
    const segments = timelineSegments(data.intervals || [], data.from, data.to);
    if (segments.length) timelineChart(row, segments);
  });
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

async function loadLightStats(root) {
  const host = root.querySelector(".light-stats-host");
  const panel = root.querySelector(".light-panel");
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
      if (panel) panel.hidden = true;
      return;
    }
    if (panel) panel.hidden = false;
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
    const bars = rooms.map((room) => ({
      label: room.room || "Без комнаты",
      value: Number(room.total) || 0,
    }));
    const short = Math.max(0, ...bars.map((bar) => bar.value)) < 120;
    barChart(host.querySelector(".light-chart"), bars, {
      height: 160,
      divisor: short ? 1 : 60,
      unit: short ? "мин" : "ч",
      valueFormatter: short
        ? (value) => Math.round(Number(value) || 0) + " мин"
        : null,
      aria: "Минуты света по комнатам",
    });
  } catch (error) {
    if (!isCurrentLoad("light", token)) return;
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadTrafficTable(root) {
  const hoursSelect = root.querySelector(".traffic-hours");
  const host = root.querySelector(".traffic-table-host");
  if (!host) return;
  const token = beginLoad("traffic");
  host.innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const hours = Number(hoursSelect && hoursSelect.value) || 24;
    const data = await getTrafficTable({ hours });
    if (!isCurrentLoad("traffic", token)) return;
    host.innerHTML = trafficTableHtml(
      data.rows || [],
      (stateRef && stateRef.devices) || [],
      data.source,
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
        value: Number(sample.load1) || 0,
      })),
      {
        height: 160,
        valueFormatter: (value) => Number(value).toFixed(2),
        aria: "Load average роутера за 1 минуту",
      },
    );
    const last = samples[samples.length - 1];
    host.insertAdjacentHTML(
      "beforeend",
      '<p class="muted router-summary">Память: ' +
        esc(formatTraffic(last.mem_used)) +
        " · WAN: " +
        (last.wan_up ? "подключён" : "нет связи") +
        ".</p>",
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
  if (target.classList.contains("traffic-hours")) {
    loadTrafficTable(root);
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
  if (target.classList.contains("tl-day")) {
    loadTimeline(root);
  } else if (
    target.classList.contains("sig-mac") ||
    target.classList.contains("sig-hours")
  ) {
    loadSignal(root);
  }
}

function setTab(root, tab) {
  const grid = root.querySelector(".analytics-grid");
  if (!grid || !["overview", "people", "network", "light"].includes(tab)) return;
  grid.dataset.tab = tab;
  root.querySelectorAll("[data-analytics-tab]").forEach((button) => {
    const active = button.dataset.analyticsTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
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
    loadHomePeople(root);
    return;
  }
  builtKey = key;

  root.innerHTML = shell(people, devices);
  root.onchange = (event) => onChange(root, event);
  root.onclick = (event) => {
    const tab = event.target.closest("[data-analytics-tab]");
    if (tab) setTab(root, tab.dataset.analyticsTab);
  };
  loadOverview(root);
  loadHomePeople(root);
  loadTimeline(root);
  loadSignal(root);
  loadTimeMachine(root);
  loadUptime(root);
  loadRouter(root);
  loadTrafficTable(root);
  loadLightStats(root);
}
