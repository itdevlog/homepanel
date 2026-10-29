/** Главная страница: кто дома, состояние дома, инфраструктура и свет. */

import {
  alertsFromState,
  deviceLabel,
  formatAgo,
  formatDuration,
  formatTraffic,
  groupByRoom,
  iconGlyph,
  infraDevices,
  isRandomMac,
  isUnidentified,
  plural,
  signalLabel,
} from "../lib.js";
import { avatar, deviceIconSvg, icon } from "../icons.js";
import { controlRestart, getAnomalies, getLightEvents, postJSON } from "../api.js";
import { confirmAction, promptAction, toast } from "../ui.js";
import { openDeviceDetail } from "./device-detail.js";

let anomalies = [];
let anomaliesAt = 0;
let anomaliesToken = 0;
let lightEventsToken = 0;
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

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

function todayLabel(now) {
  const date = new Date((Number(now) || Math.floor(Date.now() / 1000)) * 1000);
  const text = date.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function deviceLine(device, now) {
  const label = device.name || device.hostname || device.mac;
  const meta = [
    bandLabel(device.band),
    device.bss_name || device.bss ? esc(device.bss_name || device.bss) : "",
  ].filter(Boolean);
  const isHome = device.state === "home";
  const away = Math.max(0, now - (device.last_seen || now));
  const status = isHome
    ? esc(formatDuration(now - device.since))
    : away < 3600
      ? Math.floor(away / 60) + " мин назад"
      : Math.floor(away / 3600) + " ч назад";
  const cls = isHome ? "" : " is-away";
  const bytes = (Number(device.rx_bytes) || 0) + (Number(device.tx_bytes) || 0);
  return (
    '<li class="device-row device-open' + cls + '" data-mac="' + esc(device.mac) +
    '" title="' + esc(iconGlyph(device.icon)) + " " + esc(label) + '">' +
    '<span class="device-icon">' + deviceIconSvg(device) + "</span>" +
    '<span class="device-body"><span class="device-name">' + esc(label) +
    (device.hidden ? ' <span class="tag">скрыто</span>' : "") + "</span>" +
    (meta.length || bytes
      ? '<span class="device-meta">' + meta.join(" · ") +
        (bytes ? (meta.length ? " · " : "") + formatTraffic(bytes) + " за 5 мин" : "") +
        "</span>"
      : "") +
    "</span>" +
    '<span class="device-state"><i class="presence-dot' + (isHome ? " is-on" : "") + '"></i>' +
    esc(status) + "</span></li>"
  );
}

function personCard(person, now) {
  const visible = person.devices.filter((d) => !d.hidden);
  const hidden = person.devices.length - visible.length;
  const rows = visible.map((d) => deviceLine(d, now));
  const today = person.today_minutes == null
    ? null
    : formatDuration(person.today_minutes * 60);
  const since = person.home && person.since != null
    ? formatDuration(now - person.since)
    : "";
  const forecast = person.forecast_minutes == null
    ? ""
    : String(Math.floor(person.forecast_minutes / 60)).padStart(2, "0") + ":" +
      String(Math.floor(person.forecast_minutes % 60)).padStart(2, "0");
  const allSessions = person.sessions || [];
  const sessions = allSessions
    .slice(0, 3)
    .map((item) => '<span class="session">' + clock(item.from) + "–" + clock(item.to) + "</span>")
    .join("") +
    (allSessions.length > 3
      ? '<span class="session session-more">+' + (allSessions.length - 3) + "</span>"
      : "");
  return (
    '<article class="person-card' + (person.home ? " is-home" : "") + '">' +
    '<div class="person-top">' +
    avatar(person.person, "person-avatar") +
    '<div class="person-info"><div class="person-name-row"><h3>' + esc(person.person) + "</h3>" +
    '<span class="person-state' + (person.home ? " is-home" : "") + '">' +
    '<i class="presence-dot' + (person.home ? " is-on" : "") + '"></i>' +
    (person.home ? "дома" : "нет дома") + "</span></div>" +
    '<p class="person-sub">' +
    (person.home
      ? "уже " + esc(since)
      : today
        ? "сегодня был " + esc(today)
        : "сегодня не появлялся") +
    "</p></div>" +
    '<span class="person-move">' +
    '<button type="button" class="icon-btn person-up" data-person="' + esc(person.person) +
    '" aria-label="Поднять ' + esc(person.person) + '" title="Выше">' + icon("up") + "</button>" +
    '<button type="button" class="icon-btn person-down" data-person="' + esc(person.person) +
    '" aria-label="Опустить ' + esc(person.person) + '" title="Ниже">' + icon("down") + "</button>" +
    "</span></div>" +
    '<div class="person-stats">' +
    (today
      ? '<div class="person-stat"><span class="person-stat-value">' + esc(today) +
        '</span><span class="person-stat-label">сегодня дома</span></div>'
      : "") +
    (forecast
      ? '<div class="person-stat"><span class="person-stat-value">' + esc(forecast) +
        '</span><span class="person-stat-label">обычно приходит</span></div>'
      : "") +
    '<div class="person-stat"><span class="person-stat-value">' + visible.length +
      '</span><span class="person-stat-label">' +
      plural(visible.length, "устройство", "устройства", "устройств") + "</span></div>" +
    "</div>" +
    (sessions
      ? '<div class="person-sessions"><span class="person-sessions-label">Сегодня</span>' +
        sessions + "</div>"
      : "") +
    (rows.length
      ? '<ul class="device-list">' + rows.join("") + "</ul>"
      : '<p class="person-empty">Нет привязанных устройств</p>') +
    (hidden
      ? '<p class="person-hidden">Ещё ' + hidden + " скрыто</p>"
      : "") +
    "</article>"
  );
}

function summaryItem(iconName, value, label, cls) {
  return (
    '<div class="status-metric' + (cls ? " " + cls : "") + '">' +
    '<span class="metric-icon">' + icon(iconName) + "</span>" +
    '<span class="metric-body"><strong>' + esc(value) + "</strong>" +
    '<span>' + esc(label) + "</span></span></div>"
  );
}

function routerCard(state) {
  const router = state.router || {};
  const now = Number(state.now) || 0;
  if (!router.online) {
    const last = router.last_seen
      ? "нет связи " + formatDuration(Math.max(0, now - router.last_seen))
      : "данных ещё не было";
    return (
      '<div class="router-block is-offline">' +
      '<div class="router-title"><span class="router-icon">' + icon("router") + "</span>" +
      '<div><strong>Роутер</strong><span class="muted">' + esc(last) + "</span></div></div>" +
      '<span class="status-tag is-muted">нет связи</span></div>'
    );
  }
  const mem = router.mem_total
    ? Math.round(((router.mem_total - (router.mem_free || 0)) / router.mem_total) * 100) + "%"
    : "—";
  const load = typeof router.load1 === "number" ? router.load1.toFixed(2) : "—";
  const wan = router.wan_up ? router.wan_ip || "подключён" : "нет";
  return (
    '<div class="router-block">' +
    '<div class="router-title"><span class="router-icon">' + icon("router") + "</span>" +
    '<div><strong>Роутер</strong><span class="muted">WAN ' + esc(wan) + "</span></div></div>" +
    '<div class="router-meta">' +
    "<span><em>uptime</em>" + esc(formatDuration(router.uptime || 0)) + "</span>" +
    "<span><em>load</em>" + esc(load) + "</span>" +
    "<span><em>память</em>" + esc(mem) + "</span>" +
    "</div>" +
    '<button type="button" class="btn ghost icon-only router-restart" title="Перезапустить агент" ' +
    'aria-label="Перезапустить агент">' + icon("refresh") + "</button>" +
    "</div>"
  );
}

function statusBoard(state) {
  const people = state.people || [];
  const devices = state.devices || [];
  const home = people.filter((person) => person.home).length;
  const devicesHome = devices.filter((d) => d.state === "home" && !d.hidden).length;
  const unknown = devices.filter((d) => isUnidentified(d) && d.state === "home").length;
  const routerOnline = Boolean((state.router || {}).online);
  const agent = state.agent || {};
  const fresh = agent.online
    ? "Агент на связи"
    : agent.last_snapshot_ts
      ? "Агент не на связи · последние данные " + formatAgo(Math.max(0, state.now - agent.last_snapshot_ts))
      : "Агент ещё не присылал данные";
  return (
    '<section class="status-board">' +
    '<div class="status-metrics">' +
    summaryItem("users", home, plural(home, "человек дома", "человека дома", "человек дома"),
      home ? "is-accent" : "") +
    summaryItem("devices", devicesHome,
      plural(devicesHome, "устройство онлайн", "устройства онлайн", "устройств онлайн")) +
    summaryItem("alert", unknown,
      plural(unknown, "неопознанное", "неопознанных", "неопознанных"), unknown ? "is-warn" : "") +
    summaryItem("wifi", routerOnline ? "онлайн" : "офлайн", "роутер",
      routerOnline ? "is-ok" : "is-danger") +
    "</div>" +
    routerCard(state) +
    '<div class="status-foot"><span class="fresh-dot' + (agent.online ? " is-on" : "") + '"></span>' +
    esc(fresh) +
    (!agent.last_snapshot_ts ? "" : " · клиентов " + (agent.client_count || 0)) +
    "</div></section>"
  );
}

function alertsBlock(state) {
  const alerts = alertsFromState(state).filter(
    (alert) => alert.key !== "no-data" && alert.key !== "agent-offline",
  );
  if (!alerts.length) return "";
  return (
    '<div class="alerts">' +
    alerts
      .map(
        (alert) =>
          '<div class="alert alert-' + alert.level + '">' + icon(alert.level === "danger" ? "alert" : "info") +
          "<span>" + esc(alert.text) + "</span></div>",
      )
      .join("") +
    "</div>"
  );
}

function clock(ts) {
  const date = new Date(Number(ts) * 1000);
  return (
    String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0")
  );
}

function infraDeviceRow(device, now) {
  const online = device.state === "home";
  const meta = [];
  if (device.signal != null) meta.push("сигнал " + signalLabel(device.signal));
  if (online) {
    if (device.since) meta.push("в сети " + formatDuration(Math.max(0, now - device.since)));
  } else if (device.last_seen) {
    meta.push("ушёл " + formatAgo(Math.max(0, now - device.last_seen)));
  } else {
    meta.push("не видели");
  }
  return (
    '<button type="button" class="infra-device device-open' +
    (online ? "" : " is-offline") + '" data-mac="' + esc(device.mac) + '">' +
    '<span class="infra-device-icon">' + deviceIconSvg(device) + "</span>" +
    '<span class="infra-device-main">' +
    '<span class="infra-device-name">' + esc(deviceLabel(device)) + "</span>" +
    (meta.length ? '<span class="infra-device-meta">' + esc(meta.join(" · ")) + "</span>" : "") +
    "</span>" +
    '<span class="infra-state' + (online ? " is-on" : "") + '">' +
    '<i class="presence-dot' + (online ? " is-on" : "") + '"></i>' +
    (online ? "в сети" : "не в сети") + "</span></button>"
  );
}

function infraBlock(state) {
  const groups = groupByRoom(infraDevices(state.devices));
  const content = groups.length
    ? groups
        .map((group) => {
          const name = group.room || "Без комнаты";
          return (
            '<article class="infra-card' + (group.online ? "" : " is-off") + '">' +
            '<header class="infra-card-head"><h4>' + esc(name) + "</h4>" +
            '<span class="infra-card-count">' + group.online + " из " + group.total +
            " в сети</span></header>" +
            '<div class="infra-devices">' +
            group.devices.map((device) => infraDeviceRow(device, state.now)).join("") +
            "</div></article>"
          );
        })
        .join("")
    : '<p class="muted">Инфраструктурные устройства не размечены. Укажите тип или роль ' +
      "«инфраструктура» на странице «Устройства».</p>";
  return (
    '<section class="panel infra-panel"><div class="panel-head"><div>' +
    "<h2>Инфраструктура</h2>" +
    '<p class="panel-sub">Техника и датчики без людей. Нажмите, чтобы открыть детали.</p>' +
    '</div><span class="panel-icon">' + icon("cpu") + "</span></div>" +
    '<div class="infra-grid">' + content + "</div></section>"
  );
}

function lightsBlock(state) {
  const rows = state.lights || [];
  if (!rows.length) return "";
  const onCount = rows.filter((row) => row.on).length;
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
        '<div class="light-head"><span class="light-name">' + icon("light") + esc(name) + "</span>" +
        '<span class="light-state">' + (on ? "включён" : "выключен") + "</span></div>" +
        '<div class="light-meta">' + online + " из " + total +
        (since ? " · " + since : "") + "</div></div>"
      );
    })
    .join("");
  return (
    '<section class="panel lights-panel"><div class="panel-head"><div>' +
    "<h2>Свет</h2>" +
    '<p class="panel-sub">' + (onCount ? "Сейчас включено в " + onCount + " " +
      plural(onCount, "комнате", "комнатах", "комнатах") : "Во всех комнатах выключен") +
    "</p></div>" +
    '<span class="panel-icon">' + icon("light") + "</span></div>" +
    '<div class="lights-grid">' + rooms + "</div>" +
    '<details class="light-events-details"><summary><span>Последние события</span>' +
    '<span class="light-last muted">…</span></summary>' +
    '<div class="light-events-host"><p class="muted">Загрузка событий…</p></div></details>' +
    "</section>"
  );
}

async function loadLightEvents(root) {
  const host = root.querySelector(".light-events-host");
  if (!host) return;
  const token = ++lightEventsToken;
  try {
    const data = await getLightEvents(5);
    if (token !== lightEventsToken || !host.isConnected) return;
    const events = data.events || [];
    const last = root.querySelector(".light-last");
    if (!events.length) {
      if (last) last.textContent = "пока нет";
      host.innerHTML = '<p class="muted">Событий пока нет.</p>';
      return;
    }
    if (last) {
      const event = events[0];
      last.textContent =
        clock(event.ts) + " · " + (event.room || "Без комнаты") +
        (event.state === "on" ? " включён" : " выключен");
    }
    host.innerHTML =
      '<ul class="light-events">' +
      events
        .map(
          (event) =>
            '<li><span class="light-event-time">' + clock(event.ts) + "</span>" +
            "<span>" + esc(event.room || "Без комнаты") + ": свет " +
            (event.state === "on" ? "включён" : "выключен") +
            (event.count ? " (" + event.count + ")" : "") + "</span></li>",
        )
        .join("") +
      "</ul>";
  } catch (error) {
    if (token !== lightEventsToken || !host.isConnected) return;
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
    device.signal == null ? "" : "сигнал " + signalLabel(device.signal),
    device.state === "home"
      ? "дома"
      : device.last_seen
        ? "ушёл " + esc(formatAgo(now - device.last_seen))
        : "не видели",
  ].filter(Boolean);
  return (
    '<div class="unknown-row">' +
    '<span class="unknown-icon">' + deviceIconSvg(device) + "</span>" +
    '<span class="unknown-main"><span class="unknown-mac">' + esc(device.mac) + "</span>" +
    '<span class="unknown-meta">' + meta.join(" · ") + "</span></span>" +
    '<span class="unknown-actions">' +
    '<button type="button" class="btn small quick-person" data-mac="' + esc(device.mac) +
    '">' + icon("user") + "Назначить</button>" +
    '<button type="button" class="btn small ghost quick-hide" data-mac="' + esc(device.mac) +
    '">Скрыть</button>' +
    "</span></div>"
  );
}

function anomaliesBlock() {
  if (!anomalies.length) return "";
  return (
    '<div class="anomalies">' +
    anomalies
      .map(
        (item) =>
          '<div class="anomaly anomaly-' + esc(item.level) + '">' + icon("alert") +
          "<span>" + esc(item.text) + "</span></div>",
      )
      .join("") +
    "</div>"
  );
}

function maybeLoadAnomalies(root) {
  const stamp = Date.now();
  if (stamp - anomaliesAt < 60000) {
    const host = root.querySelector(".anomalies-host");
    if (host) host.innerHTML = anomaliesBlock();
    return;
  }
  anomaliesAt = stamp;
  const token = ++anomaliesToken;
  getAnomalies()
    .then((data) => {
      if (token !== anomaliesToken) return;
      anomalies = (data && data.items) || [];
      const host = root.querySelector(".anomalies-host");
      if (host && host.isConnected) host.innerHTML = anomaliesBlock();
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
    const ok = await confirmAction(
      "Связь с роутером прервётся на несколько секунд, затем восстановится.",
      { title: "Перезапустить агент?", confirmLabel: "Перезапустить" },
    );
    if (!ok) return;
    try {
      await controlRestart();
      toast("Команда перезапуска отправлена", "success");
      window.dispatchEvent(new Event("homepanel:refresh"));
    } catch (error) {
      toast(error.message, "error");
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
    const person = await promptAction({
      title: "Чьё это устройство?",
      label: "Имя человека",
      placeholder: "например, Алексей",
      confirmLabel: "Привязать",
    });
    if (person) {
      try {
        await postJSON("/api/devices", { mac, person });
        toast("Устройство привязано к " + person, "success");
        window.dispatchEvent(new Event("homepanel:refresh"));
      } catch (error) {
        toast(error.message, "error");
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
      toast(error.message, "error");
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
    '<details class="weak-panel"><summary>' + icon("signal") +
    "Слабый сигнал · " + weak.length + "</summary><div class=\"weak-list\">" +
    weak
      .map(
        (device) =>
          '<div class="weak-row"><span class="weak-name">' +
          deviceIconSvg(device) + esc(device.name || device.person || device.mac) +
          '</span><span class="sub">' +
          esc(signalLabel(device.signal)) + " · " + device.signal + " dBm</span></div>",
      )
      .join("") +
    "</div></details>"
  );
}

export function render(root, state) {
  lastState = state;
  const now = state.now;
  const people = state.people || [];
  const devices = state.devices || [];
  const unknown = devices.filter(isUnidentified);
  const home = people.filter((person) => person.home);
  const devicesHome = devices.filter((d) => d.state === "home" && !d.hidden).length;
  const homeNames = home.map((person) => person.person).join(", ");
  const sub = (home.length
    ? homeNames + (home.length === 1 ? " дома" : " дома")
    : "Дома никого") +
    " · " + devicesHome + " " +
    plural(devicesHome, "устройство в сети", "устройства в сети", "устройств в сети");

  const peopleHtml = people.length
    ? '<div class="people-grid">' + orderedPeople(people).map((p) => personCard(p, now)).join("") + "</div>"
    : '<div class="empty-state">' + icon("users") +
      "<h3>Люди ещё не размечены</h3>" +
      "<p>Задайте имена устройств на странице «Устройства» — здесь появятся карточки жильцов.</p>" +
      '<a class="btn primary" href="#/devices">Перейти к устройствам</a></div>';

  const unknownHtml = unknown.length
    ? '<section class="panel unknown-panel"><div class="panel-head"><div><h2>Неопознанные устройства</h2>' +
      '<p class="panel-sub">Их можно назвать и привязать к человеку.</p></div>' +
      '<span class="count-pill">' + unknown.length + "</span></div>" +
      '<div class="unknown-list">' + unknown.map((d) => unknownRow(d, now)).join("") + "</div></section>"
    : "";

  root.onclick = onClick;
  root.innerHTML =
    '<section class="page home-page">' +
    '<header class="page-head"><div>' +
    '<p class="eyebrow">' + esc(todayLabel(now)) + "</p>" +
    "<h1>" + greeting() + "</h1>" +
    '<p class="page-sub">' + esc(sub) + "</p>" +
    "</div>" +
    '<span class="live-chip' + (state.agent && state.agent.online ? " is-online" : "") + '">' +
    '<i></i>' + (state.agent && state.agent.online ? "Дом на связи" : "Нет связи с агентом") +
    "</span></header>" +
    alertsBlock(state) +
    '<div class="anomalies-host">' + anomaliesBlock() + "</div>" +
    statusBoard(state) +
    '<section class="people-section"><div class="section-head"><h2>Кто дома</h2>' +
    '<span class="section-meta">' + home.length + " из " + people.length + "</span></div>" +
    peopleHtml + "</section>" +
    '<div class="home-grid">' +
    infraBlock(state) +
    '<div class="home-side">' + lightsBlock(state) + weakBlock(state) + "</div>" +
    "</div>" +
    unknownHtml +
    "</section>";
  maybeLoadAnomalies(root);
  loadLightEvents(root);
}
