/** Хэш-роутер панели, тема оформления и общий цикл опроса сервера. */

import { getState } from "./api.js";
import { alertsFromState, nextTheme } from "./lib.js";

const POLL_MS = 10000;
const THEME_KEY = "homepanel.theme";
const THEME_LABELS = { auto: "Авто", dark: "Тёмная", light: "Светлая" };

const TITLES = {
  "": "Кто дома",
  devices: "Устройства",
  history: "История",
  analytics: "Аналитика",
  settings: "Настройки",
};

const ROUTES = {
  "": () => import("./views/home.js"),
  devices: () => import("./views/devices.js"),
  history: () => import("./views/history.js"),
  analytics: () => import("./views/analytics.js"),
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
  for (const link of document.querySelectorAll(".topnav a[data-route]")) {
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

document.querySelector(".theme-toggle")?.addEventListener("click", cycleTheme);
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (theme === "auto") applyTheme();
  });
}
applyTheme();
syncNavHeight();

window.addEventListener("hashchange", loadRoute);
loadRoute().then(poll);
setInterval(poll, POLL_MS);
