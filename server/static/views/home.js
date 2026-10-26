/** Главная страница: сводка, предупреждения, кто дома и неопознанные. */

import {
  alertsFromState,
  formatAgo,
  formatBytes,
  formatDuration,
  iconGlyph,
  isRandomMac,
  isUnidentified,
  plural,
} from "../lib.js";
import { controlRestart, getAnomalies, getLightEvents, postJSON } from "../api.js";
import { openDeviceDetail } from "./device-detail.js";

let anomalies = [];
let anomaliesAt = 0;
let lastState = null;

const ORDER_KEY = "homepanel.peopleOrder";

function readOrder() {
  try {
    const value = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
    return Array.isArray(value) ? value.filter((name) => typeof name === "string") : [];
  } catch (err) {
    return [];
  }
}

function orderedPeople(people) {
  const order = readOrder();
  if (!order.length) return people;
  const rank = new Map(order.map((name, index) => [name, index]));
  return people.slice().sort((a, b) => {
    const ra = rank.has(a.person) ? rank.get(a.person) : order.length + 1;
    const rb = rank.has(b.person) ? rank.get(b.person) : order.length + 1;
    if (ra !== rb) return ra - rb;
    return a.home === b.home ? 0 : a.home ? -1 : 1;
  });
}

function movePerson(person, delta) {
  const names = orderedPeople((lastState && lastState.people) || []).map((p) => p.person);
  const index = names.indexOf(person);
  if (index < 0) return;
  const next = Math.max(0, Math.min(names.length - 1, index + delta));
  if (next === index) return;
  names.splice(next, 0, names.splice(index, 1)[0]);
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(names));
  } catch (err) {
    /* приватный режим */
  }
  window.dispatchEvent(new Event("homepanel:refresh"));
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

function bandLabel(band) {
  if (band === "2.4") return "2.4 ГГц";
  if (band === "5") return "5 ГГц";
  return band ? esc(band) + " ГГц" : "";
}

function deviceLine(device, now) {
  const label = device.name || device.hostname || device.mac;
  const meta = [
    bandLabel(device.band),
    device.bss_name || device.bss ? esc(device.bss_name || device.bss) : "",
    device.signal == null ? "" : device.signal + " dBm",
  ].filter(Boolean);
  const isHome = device.state === "home";
  const status = isHome
    ? "онлайн " + esc(formatDuration(now - device.since))
    : "последний раз " + esc(formatDuration(now - (device.last_seen || now))) + " назад";
  const cls = isHome ? "" : " off";
  const bytes = (Number(device.rx_bytes) || 0) + (Number(device.tx_bytes) || 0);
  return (
    '<li class="device-open' + cls + '" data-mac="' + esc(device.mac) + '">' +
    '<span class="name"><span class="dev-icon">' +
    iconGlyph(device.icon) +
    "</span>" +
    esc(label) +
    "</span>" +
    (device.hidden ? '<span class="meta">скрыто</span>' : "") +
    '<span class="meta">' + meta.join(" · ") + "</span>" +
    (bytes ? '<span class="meta">5 мин: ' + esc(formatBytes(bytes)) + "</span>" : "") +
    '<span class="meta">' + status + "</span>" +
    "</li>"
  );
}

function summaryItem(value, label, cls) {
  return (
    '<div class="summary-item' + (cls ? " " + cls : "") + '">' +
    '<span class="summary-value">' + esc(value) + "</span>" +
    '<span class="summary-label">' + esc(label) + "</span></div>"
  );
}

function summary(state) {
  const people = state.people || [];
  const devices = state.devices || [];
  const home = people.filter((person) => person.home).length;
  const devicesHome = devices.filter((d) => d.state === "home" && !d.hidden).length;
  const unknown = devices.filter((d) => isUnidentified(d) && d.state === "home").length;
  const online = Boolean((state.agent || {}).online);

  const items = [
    summaryItem(
      home,
      plural(home, "человек дома", "человека дома", "человек дома"),
      home ? "is-home" : "",
    ),
    summaryItem(
      devicesHome,
      plural(devicesHome, "устройство дома", "устройства дома", "устройств дома"),
    ),
    summaryItem(
      unknown,
      plural(unknown, "неопознанное", "неопознанных", "неопознанных"),
      unknown ? "is-warn" : "",
    ),
    summaryItem(online ? "онлайн" : "офлайн", "роутер", online ? "is-home" : "is-warn"),
  ];

  return '<div class="summary">' + items.join("") + "</div>";
}

function routerCard(state) {
  const router = state.router || {};
  const now = Number(state.now) || 0;
  if (!router.online) {
    const last = router.last_seen
      ? "Последний контакт " + formatDuration(Math.max(0, now - router.last_seen)) + " назад."
      : "Данных о роутере ещё не было.";
    return (
      '<div class="router-card is-off">' +
      '<div class="router-head"><strong>Роутер</strong><span class="badge">нет связи</span></div>' +
      '<p class="muted">' + esc(last) + "</p></div>"
    );
  }
  const mem = router.mem_total
    ? Math.round(((router.mem_total - (router.mem_free || 0)) / router.mem_total) * 100) + "%"
    : "—";
  const load = typeof router.load1 === "number" ? router.load1.toFixed(2) : "—";
  const wan = router.wan_up ? router.wan_ip || "подключён" : "нет";
  return (
    '<div class="router-card">' +
    '<div class="router-head"><strong>Роутер</strong><span class="badge home">онлайн</span>' +
    '<button type="button" class="btn ghost router-restart">Перезапустить</button></div>' +
    '<div class="router-grid">' +
    "<span><em>uptime</em>" + esc(formatDuration(router.uptime || 0)) + "</span>" +
    "<span><em>load 1m</em>" + esc(load) + "</span>" +
    "<span><em>память</em>" + esc(mem) + "</span>" +
    "<span><em>WAN</em>" + esc(wan) + "</span>" +
    "</div></div>"
  );
}

function alertsBlock(state) {
  const alerts = alertsFromState(state);
  if (!alerts.length) return "";
  return (
    '<div class="alerts">' +
    alerts
      .map((alert) => '<div class="alert alert-' + alert.level + '">' + esc(alert.text) + "</div>")
      .join("") +
    "</div>"
  );
}

function clock(ts) {
  const date = new Date(Number(ts) * 1000);
  return (
    String(date.getHours()).padStart(2, "0") +
    ":" +
    String(date.getMinutes()).padStart(2, "0")
  );
}

function clockMinutes(minutes) {
  const value = Math.max(0, Number(minutes) || 0);
  return (
    String(Math.floor(value / 60)).padStart(2, "0") +
    ":" +
    String(Math.floor(value % 60)).padStart(2, "0")
  );
}

function personCard(person, now) {
  const visible = person.devices.filter((d) => !d.hidden);
  const lines = (visible.length ? visible : person.devices).map((d) => deviceLine(d, now));
  const today =
    person.today_minutes == null
      ? ""
      : " · сегодня " + formatDuration(person.today_minutes * 60);
  const since = person.home && person.since != null
    ? "дома уже " + esc(formatDuration(now - person.since)) + today
    : "не дома" + today;
  const forecast =
    person.forecast_minutes == null
      ? ""
      : '<p class="forecast">Обычно приходит в ' +
        clockMinutes(person.forecast_minutes) +
        "</p>";
  const sessions = (person.sessions || [])
    .map((item) => '<span class="session">' + clock(item.from) + "–" + clock(item.to) + "</span>")
    .join("");
  return (
    '<article class="card' + (person.home ? " is-home" : "") + '">' +
    "<header><h3>" + esc(person.person) + "</h3>" +
    '<span class="person-order">' +
    '<button type="button" class="person-up" data-person="' + esc(person.person) + '" aria-label="Выше">↑</button>' +
    '<button type="button" class="person-down" data-person="' + esc(person.person) + '" aria-label="Ниже">↓</button>' +
    "</span>" +
    '<span class="badge' + (person.home ? " is-home" : "") + '">' +
    (person.home ? "дома" : "нет") + "</span></header>" +
    '<p class="since">' + since + "</p>" +
    forecast +
    (sessions ? '<p class="sessions">Сегодня: ' + sessions + "</p>" : "") +
    '<ul class="devices">' + lines.join("") + "</ul>" +
    "</article>"
  );
}

function infraBlock(state) {
  const lightByRoom = new Map(
    (state.lights || []).map((row) => [row.room || "", row]),
  );
  const rows = (state.infra || [])
    .map((row) => {
      const light = lightByRoom.get(row.room || "");
      const online = Math.max(
        0,
        (Number(row.online) || 0) - (light ? Number(light.online) || 0 : 0),
      );
      const total = Math.max(
        0,
        (Number(row.total) || 0) - (light ? Number(light.total) || 0 : 0),
      );
      return { room: row.room || "", online, total };
    })
    .filter((row) => row.total > 0);
  if (!rows.length) return "";
  const rooms = rows
    .map((row) => {
      const name = row.room || "Без комнаты";
      const online = Math.max(0, Number(row.online) || 0);
      const total = Math.max(0, Number(row.total) || 0);
      return (
        '<div class="infra-room' + (online === 0 ? " is-off" : "") + '">' +
        '<span class="infra-room-name">' + esc(name) + "</span>" +
        '<span class="infra-room-count">' + online + " из " + total + "</span>" +
        "</div>"
      );
    })
    .join("");
  return (
    '<section class="panel infra-panel"><h3>Инфраструктура</h3>' +
    '<p class="muted">ТВ, техника и другие устройства без людей.</p>' +
    '<div class="infra-grid">' + rooms + "</div></section>"
  );
}

function lightsBlock(state) {
  const rows = state.lights || [];
  if (!rows.length) return "";
  const rooms = rows
    .map((row) => {
      const name = row.room || "Без комнаты";
      const online = Math.max(0, Number(row.online) || 0);
      const total = Math.max(0, Number(row.total) || 0);
      const on = Boolean(row.on);
      const since = row.since
        ? (on ? "горит с " : "выключен с ") + clock(row.since)
        : "";
      return (
        '<div class="light-room ' + (on ? "is-on" : "is-off") + '">' +
        '<div class="light-head"><span class="light-name">' + esc(name) + "</span>" +
        '<span class="light-state">' + (on ? "включён" : "выключен") + "</span></div>" +
        '<div class="light-meta">' + online + " из " + total +
        (since ? " · " + since : "") + "</div></div>"
      );
    })
    .join("");
  return (
    '<section class="panel lights-panel"><h3>Свет</h3>' +
    '<p class="muted">Группы по комнатам: включён, если хотя бы одна лампа в сети.</p>' +
    '<div class="lights-grid">' + rooms + "</div>" +
    '<div class="light-events-host"><p class="muted">Загрузка событий…</p></div>' +
    "</section>"
  );
}

async function loadLightEvents(root) {
  const host = root.querySelector(".light-events-host");
  if (!host) return;
  try {
    const data = await getLightEvents(5);
    const events = data.events || [];
    if (!events.length) {
      host.innerHTML = '<p class="muted">Событий пока нет.</p>';
      return;
    }
    host.innerHTML =
      '<ul class="light-events">' +
      events
        .map(
          (event) =>
            '<li><span class="light-event-time">' + clock(event.ts) + "</span> " +
            esc(event.room || "Без комнаты") + ": свет " +
            (event.state === "on" ? "включён" : "выключен") +
            (event.count ? " (" + event.count + ")" : "") + "</li>",
        )
        .join("") +
      "</ul>";
  } catch (error) {
    host.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

function unknownRow(device, now) {
  const meta = [
    device.hostname ? esc(device.hostname) : "",
    isRandomMac(device.mac) ? "случайный MAC" : "",
    device.ip ? esc(device.ip) : "",
    bandLabel(device.band),
    device.bss_name || device.bss ? esc(device.bss_name || device.bss) : "",
    device.signal == null ? "" : device.signal + " dBm",
    device.state === "home"
      ? "дома"
      : device.last_seen
        ? "ушёл " + esc(formatAgo(now - device.last_seen))
        : "не видели",
  ].filter(Boolean);
  return (
    '<div class="unknown-row">' +
    '<span class="mac"><span class="dev-icon">' +
    iconGlyph(device.icon) +
    "</span>" +
    esc(device.mac) +
    "</span>" +
    '<span class="meta">' + meta.join(" · ") + "</span>" +
    '<span class="unknown-actions">' +
    '<button type="button" class="btn quick-person" data-mac="' + esc(device.mac) +
    '">Назначить</button>' +
    '<button type="button" class="btn quick-hide" data-mac="' + esc(device.mac) +
    '">Скрыть</button>' +
    "</span></div>"
  );
}

function freshness(state) {
  const agent = state.agent || {};
  const online = Boolean(agent.online);
  let text;
  if (agent.last_snapshot_ts) {
    const ago = formatAgo(Math.max(0, state.now - agent.last_snapshot_ts));
    text =
      "Последние данные от роутера: " + ago +
      (agent.client_count == null ? "" : " · клиентов: " + agent.client_count);
  } else {
    text = "Данных от роутера пока не было";
  }
  return (
    '<div class="freshness' + (online ? " is-online" : "") + '">' +
    '<span class="dot"></span><span>' + esc(text) + "</span></div>"
  );
}

function anomaliesBlock() {
  if (!anomalies.length) return "";
  return (
    '<div class="anomalies">' +
    anomalies
      .map(
        (item) =>
          '<div class="anomaly anomaly-' + esc(item.level) + '">' + esc(item.text) + "</div>",
      )
      .join("") +
    "</div>"
  );
}

function maybeLoadAnomalies() {
  const stamp = Date.now();
  if (stamp - anomaliesAt < 60000) return;
  anomaliesAt = stamp;
  getAnomalies()
    .then((data) => {
      anomalies = (data && data.items) || [];
      const host = document.querySelector("#app .anomalies-host");
      if (host) host.innerHTML = anomaliesBlock();
    })
    .catch(() => {});
}

async function onClick(event) {
  const deviceLink = event.target.closest(".device-open");
  if (deviceLink) {
    const device = ((lastState && lastState.devices) || []).find(
      (item) => item.mac === deviceLink.dataset.mac,
    );
    if (device) openDeviceDetail(device, lastState.now);
    return;
  }
  if (event.target.closest(".router-restart")) {
    if (!confirm("Перезапустить агент на роутере? Связь прервётся на несколько секунд.")) return;
    try {
      await controlRestart();
      window.dispatchEvent(new Event("homepanel:refresh"));
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const up = event.target.closest(".person-up");
  if (up) {
    movePerson(up.dataset.person, -1);
    return;
  }
  const down = event.target.closest(".person-down");
  if (down) {
    movePerson(down.dataset.person, 1);
    return;
  }
  const personButton = event.target.closest(".quick-person");
  if (personButton) {
    const mac = personButton.dataset.mac;
    const person = window.prompt("Имя человека для устройства " + mac + ":");
    if (person && person.trim()) {
      try {
        await postJSON("/api/devices", { mac, person: person.trim() });
        window.dispatchEvent(new Event("homepanel:refresh"));
      } catch (error) {
        window.alert(error.message);
      }
    }
    return;
  }

  const hideButton = event.target.closest(".quick-hide");
  if (hideButton) {
    try {
      await postJSON("/api/devices", { mac: hideButton.dataset.mac, hidden: true });
      window.dispatchEvent(new Event("homepanel:refresh"));
    } catch (error) {
      window.alert(error.message);
    }
  }
}


function weakBlock(state) {
  const weak = (state.devices || []).filter(
    (device) =>
      device.state === "home" &&
      !device.hidden &&
      device.signal != null &&
      device.signal <= -75,
  );
  if (!weak.length) return "";
  return (
    '<div class="weak-list"><h3>Слабый сигнал</h3>' +
    weak
      .map(
        (device) =>
          '<div class="weak-row"><span>' +
          esc(device.name || device.person || device.mac) +
          '</span><span class="sub">' +
          device.signal +
          " dBm</span></div>",
      )
      .join("") +
    "</div>"
  );
}

export function render(root, state) {
  lastState = state;
  const now = state.now;
  const people = state.people || [];
  const devices = state.devices || [];
  const unknown = devices.filter(isUnidentified);

  const peopleHtml = people.length
    ? '<div class="cards">' + orderedPeople(people).map((p) => personCard(p, now)).join("") + "</div>"
    : '<p class="muted">Люди ещё не размечены — задайте имена на странице «Устройства».</p>';

  const unknownHtml = unknown.length
    ? '<div class="unknown-list">' + unknown.map((d) => unknownRow(d, now)).join("") + "</div>"
    : '<p class="muted">Неопознанных устройств нет.</p>';

  root.onclick = onClick;
  root.innerHTML =
    summary(state) +
    routerCard(state) +
    infraBlock(state) +
    lightsBlock(state) +
    alertsBlock(state) +
    '<div class="anomalies-host">' + anomaliesBlock() + "</div>" +
    freshness(state) +
    "<h2>Кто дома</h2>" + peopleHtml +
    "<h2>Неопознанные устройства</h2>" + unknownHtml;
  maybeLoadAnomalies();
  loadLightEvents(root);
}
