/** Хэш-роутер панели, тема оформления и общий цикл опроса сервера. */

import { getEvents, getState } from "./api.js";
import { alertsFromState, nextTheme, searchMatches } from "./lib.js";

const POLL_MS = 10000;
const THEME_KEY = "homepanel.theme";
const THEME_LABELS = { auto: "Авто", dark: "Тёмная", light: "Светлая" };

const TITLES = {
  "": "Кто дома",
  devices: "Устройства",
  history: "История",
  analytics: "Аналитика",
  tv: "ТВ-режим",
  settings: "Настройки",
};

const ROUTES = {
  "": () => import("./views/home.js"),
  devices: () => import("./views/devices.js"),
  history: () => import("./views/history.js"),
  analytics: () => import("./views/analytics.js"),
  tv: () => import("./views/tv.js"),
  settings: () => import("./views/settings.js"),
};

let currentName = null;
let currentModule = null;
let latestState = null;
let theme = readTheme();

function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "dark" || stored === "light" ? stored : "auto";
  } catch (err) {
    return "auto";
  }
}

function systemTheme() {
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

function applyTheme() {
  document.documentElement.dataset.theme = theme === "auto" ? systemTheme() : theme;
  const button = document.querySelector(".theme-toggle");
  if (!button) return;
  button.textContent = THEME_LABELS[theme];
  button.title = "Тема: " + THEME_LABELS[theme];
  button.setAttribute("aria-label", "Тема: " + THEME_LABELS[theme]);
}

function cycleTheme() {
  theme = nextTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (err) {
    /* приватный режим — тема живёт до перезагрузки */
  }
  applyTheme();
}

function updateBadge(state) {
  const badge = document.querySelector(".nav-badge");
  if (!badge) return;
  const alerts = alertsFromState(state);
  badge.hidden = alerts.length === 0;
  badge.textContent = String(alerts.length);
  badge.dataset.level = alerts.some((alert) => alert.level === "danger")
    ? "danger"
    : "warn";
  badge.title = alerts.length
    ? alerts.map((alert) => alert.text).join("\n")
    : "Нет предупреждений";
}

/** Реальная высота липкой навигации — для `top` заголовка таблицы. */
function syncNavHeight() {
  const nav = document.querySelector(".topnav");
  if (!nav) return;
  const apply = () => {
    document.documentElement.style.setProperty("--nav-h", nav.offsetHeight + "px");
  };
  apply();
  if ("ResizeObserver" in window) {
    new ResizeObserver(apply).observe(nav);
  }
  window.addEventListener("resize", apply);
}

function routeName() {
  const hash = location.hash.replace(/^#\/?/, "");
  return Object.prototype.hasOwnProperty.call(ROUTES, hash) ? hash : "";
}

function markActive(name) {
  for (const link of document.querySelectorAll(
    ".topnav a[data-route], .bottomnav a[data-route]",
  )) {
    if (link.dataset.route === name) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

function root() {
  return document.getElementById("app");
}

function paint() {
  if (!latestState) {
    return;
  }
  if (currentModule && typeof currentModule.render === "function") {
    currentModule.render(root(), latestState);
  }
}

async function loadRoute() {
  const name = routeName();
  closeSearch();
  markActive(name);
  document.body.dataset.route = name;
  if (name === currentName && currentModule) {
    paint();
    return;
  }
  currentName = name;
  document.title = "Home Panel — " + TITLES[name];
  try {
    currentModule = await ROUTES[name]();
  } catch (err) {
    currentModule = null;
    root().innerHTML =
      '<p class="muted">Раздел «' + TITLES[name] + '» ещё не готов.</p>';
  }
  paint();
}

async function poll() {
  try {
    latestState = await getState();
    document.body.classList.remove("stale");
  } catch (err) {
    document.body.classList.add("stale");
    if (!latestState) {
      root().innerHTML = '<p class="error">Нет связи с сервером: ' + err.message + "</p>";
    }
    return;
  }
  updateBadge(latestState);
  if (!document.body.classList.contains("stale")) {
    paint();
  }
}

/* -- Глобальный поиск (Ctrl+K) ---------------------------------------- */

let searchEvents = null;
let searchLoading = null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function searchDialog() {
  return document.querySelector(".search-dialog");
}

function loadSearchEvents() {
  if (searchEvents) return Promise.resolve(searchEvents);
  if (!searchLoading) {
    searchLoading = getEvents(null, 500)
      .then((list) => {
        searchEvents = list;
        return list;
      })
      .catch(() => {
        searchEvents = [];
        return searchEvents;
      });
  }
  return searchLoading;
}

function eventHit(event) {
  const date = new Date(Number(event.ts) * 1000);
  const time = date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const kind = event.type === "arrived" ? "пришёл" : "ушёл";
  return (
    '<a class="search-hit" href="#/history" data-close>' +
    '<span class="search-kind">' + kind + "</span>" +
    '<span class="search-title">' + esc(event.mac) + "</span>" +
    '<span class="search-meta">' + esc(time) + "</span></a>"
  );
}

function deviceHit(device) {
  const label = device.name || device.person || device.mac;
  const meta = [device.mac, device.ip, device.person].filter(Boolean).join(" · ");
  return (
    '<a class="search-hit" href="#/devices" data-close>' +
    '<span class="search-kind' + (device.state === "home" ? " is-home" : "") + '">' +
    (device.state === "home" ? "дома" : "нет") + "</span>" +
    '<span class="search-title">' + esc(label) + "</span>" +
    '<span class="search-meta">' + esc(meta) + "</span></a>"
  );
}

function renderSearch(query) {
  const dialog = searchDialog();
  if (!dialog) return;
  const box = dialog.querySelector(".search-results");
  if (!box) return;
  const value = String(query || "").trim();
  if (!value) {
    box.innerHTML = '<p class="muted">Начните вводить запрос.</p>';
    return;
  }
  if (!latestState) {
    box.innerHTML = '<p class="muted">Данные ещё не загружены.</p>';
    return;
  }

  const found = searchMatches(latestState.devices || [], searchEvents || [], value);
  const parts = [];
  if (found.devices.length) {
    parts.push('<div class="search-group">Устройства</div>');
    parts.push(found.devices.map(deviceHit).join(""));
  }
  if (found.events.length) {
    parts.push('<div class="search-group">События</div>');
    parts.push(found.events.map(eventHit).join(""));
  }
  box.innerHTML = parts.length ? parts.join("") : '<p class="muted">Ничего не найдено.</p>';
}

function openSearch() {
  const dialog = searchDialog();
  if (!dialog) return;
  const input = dialog.querySelector(".global-search");
  if (!dialog.open) dialog.showModal();
  if (input) {
    input.value = "";
    input.focus();
  }
  renderSearch("");
  if (latestState) {
    loadSearchEvents().then(() => renderSearch(input ? input.value : ""));
  }
}

function closeSearch() {
  const dialog = searchDialog();
  if (dialog && dialog.open) dialog.close();
}

function onSearchKey(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
    return;
  }
  if (!searchDialog() || !searchDialog().open) return;
  if (event.key === "Escape") {
    closeSearch();
  } else if (event.key === "Enter") {
    const first = searchDialog().querySelector(".search-hit");
    if (first) {
      event.preventDefault();
      closeSearch();
      location.hash = first.getAttribute("href");
    }
  }
}

document.querySelector(".theme-toggle")?.addEventListener("click", cycleTheme);
document.querySelector(".nav-search")?.addEventListener("click", openSearch);
document.addEventListener("keydown", onSearchKey);
document.querySelector(".search-dialog")?.addEventListener("input", (event) => {
  if (event.target.classList.contains("global-search")) {
    renderSearch(event.target.value);
  }
});
document.querySelector(".search-dialog")?.addEventListener("click", (event) => {
  if (event.target.closest("[data-close]")) closeSearch();
});
window.addEventListener("homepanel:refresh", () => {
  searchEvents = null;
  searchLoading = null;
  poll();
});
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (theme === "auto") applyTheme();
  });
}
applyTheme();
syncNavHeight();


const ROUTE_KEYS = {
  h: "",
  d: "devices",
  i: "history",
  a: "analytics",
  t: "tv",
  s: "settings",
};

function onHotkey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const tag = (event.target && event.target.tagName || "").toLowerCase();
  if (
    tag === "input" || tag === "textarea" || tag === "select" ||
    (event.target && event.target.isContentEditable)
  ) {
    return;
  }
  if (event.key === "/") {
    event.preventDefault();
    openSearch();
    return;
  }
  const route = ROUTE_KEYS[event.key.toLowerCase()];
  if (route === undefined) return;
  event.preventDefault();
  location.hash = route ? "#/" + route : "#/";
}

document.addEventListener("keydown", onHotkey);

window.addEventListener("hashchange", loadRoute);
loadRoute().then(() => {
  poll();
  if (new URLSearchParams(location.search).get("search") === "1") {
    openSearch();
  }
});
setInterval(poll, POLL_MS);
