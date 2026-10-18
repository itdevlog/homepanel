/** Хэш-роутер панели и общий цикл опроса сервера. */

import { getState } from "./api.js";

const POLL_MS = 10000;

const TITLES = {
  "": "Кто дома",
  devices: "Устройства",
  history: "История",
  settings: "Настройки",
};

const ROUTES = {
  "": () => import("./views/home.js"),
  devices: () => import("./views/devices.js"),
  history: () => import("./views/history.js"),
  settings: () => import("./views/settings.js"),
};

let currentName = null;
let currentModule = null;
let latestState = null;

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
  if (!document.body.classList.contains("stale")) {
    paint();
  }
}

window.addEventListener("hashchange", loadRoute);
loadRoute().then(poll);
setInterval(poll, POLL_MS);
