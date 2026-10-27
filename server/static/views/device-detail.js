/** Единая карточка устройства: сигнал, трафик и присутствие в одном месте. */
import { getSignal, getTimeline, getTraffic } from "../api.js";
import { barChart, signalChart, timelineChart } from "../charts.js";
import {
  deviceLabel,
  formatBytes,
  formatDuration,
  iconGlyph,
  timelineSegments,
} from "../lib.js";

let dialog = null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function clock(ts) {
  const date = new Date(Number(ts) * 1000);
  return (
    String(date.getHours()).padStart(2, "0") +
    ":" +
    String(date.getMinutes()).padStart(2, "0")
  );
}

function ago(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return formatDuration(value);
}

function ensureDialog() {
  if (dialog && document.body.contains(dialog)) return dialog;
  dialog = document.createElement("dialog");
  dialog.className = "device-dialog";
  document.body.appendChild(dialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  return dialog;
}

function metric(label, value) {
  return (
    '<div class="device-metric"><span class="device-metric-value">' +
    esc(value) +
    '</span><span class="device-metric-label">' +
    esc(label) +
    "</span></div>"
  );
}

function identityRow(label, value) {
  return (
    '<div class="device-identity-row"><span>' +
    esc(label) +
    "</span><strong>" +
    esc(value) +
    "</strong></div>"
  );
}

function isCurrentDetail(section, mac) {
  return Boolean(
    dialog &&
      dialog.open &&
      dialog.dataset.mac === mac &&
      section &&
      section.isConnected,
  );
}

async function loadSignal(section, mac, fromFallback, toFallback) {
  try {
    const data = await getSignal({ mac, hours: 24 });
    if (!isCurrentDetail(section, mac)) return;
    const points = (data.points || []).filter((point) =>
      Number.isFinite(Number(point.signal)),
    );
    if (!points.length) {
      section.innerHTML = '<p class="muted">Нет замеров сигнала за сутки.</p>';
      return;
    }
    const values = points.map((point) => Number(point.signal));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    const from = Number(data.from) || fromFallback || points[0].ts;
    const to = Number(data.to) || toFallback || points[points.length - 1].ts + 60;
    section.innerHTML =
      '<div class="detail-stats">мин ' + min + " · сред " + avg +
      " · макс " + max + " dBm</div>" +
      '<div class="detail-chart"></div>';
    signalChart(section.querySelector(".detail-chart"), points, from, to);
  } catch (error) {
    if (!isCurrentDetail(section, mac)) return;
    section.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadTraffic(section, mac, fromFallback, toFallback) {
  try {
    const data = await getTraffic({ mac, hours: 24 });
    if (!isCurrentDetail(section, mac)) return;
    const samples = data.samples || [];
    if (!samples.length) {
      section.innerHTML = '<p class="muted">Нет данных о трафике за сутки.</p>';
      return;
    }
    const buckets = new Map();
    let totalRx = 0;
    let totalTx = 0;
    for (const sample of samples) {
      const rx = Number(sample.rx_bytes) || 0;
      const tx = Number(sample.tx_bytes) || 0;
      totalRx += rx;
      totalTx += tx;
      const key = Math.floor(Number(sample.ts) / 3600) * 3600;
      const item = buckets.get(key) || { rx: 0, tx: 0 };
      item.rx += rx;
      item.tx += tx;
      buckets.set(key, item);
    }
    const bars = Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([ts, item]) => ({ label: clock(ts), value: item.rx + item.tx }));
    section.innerHTML =
      '<div class="detail-stats">скачано ' + esc(formatBytes(totalRx)) +
      " · отдано " + esc(formatBytes(totalTx)) +
      (data.source === "nlbw" ? " · nlbw" : " · Wi-Fi") + "</div>" +
      '<div class="detail-chart"></div>';
    barChart(section.querySelector(".detail-chart"), bars, {
      height: 160,
      divisor: 1024,
      unit: "KiB",
      aria: "Трафик устройства за сутки",
    });
  } catch (error) {
    if (!isCurrentDetail(section, mac)) return;
    section.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

async function loadTimeline(section, mac) {
  try {
    const data = await getTimeline({ mac });
    if (!isCurrentDetail(section, mac)) return;
    const segments = timelineSegments(data.intervals || [], data.from, data.to);
    const total = segments.reduce(
      (sum, segment) => sum + Math.max(0, Number(segment.to) - Number(segment.from)),
      0,
    );
    section.innerHTML =
      '<div class="detail-stats">сегодня в сети ' + esc(formatDuration(Math.round(total / 60))) +
      "</div>" +
      '<div class="detail-chart"></div>';
    timelineChart(section.querySelector(".detail-chart"), segments);
  } catch (error) {
    if (!isCurrentDetail(section, mac)) return;
    section.innerHTML = '<p class="error">' + esc(error.message) + "</p>";
  }
}

export function openDeviceDetail(device, now = Math.floor(Date.now() / 1000)) {
  if (!device) return;
  const view = ensureDialog();
  const isHome = device.state === "home";
  const signal = device.signal == null ? "—" : device.signal + " dBm";
  const bytes = (Number(device.rx_bytes) || 0) + (Number(device.tx_bytes) || 0);
  const traffic = bytes ? formatBytes(bytes) : "—";
  const localNow = Number(now) || Math.floor(Date.now() / 1000);
  view.dataset.mac = String(device.mac);

  view.innerHTML =
    '<div class="dialog-head">' +
    '<div class="dialog-title"><span class="dev-icon">' + iconGlyph(device.icon) +
    '</span><div><strong>' + esc(deviceLabel(device)) + "</strong>" +
    '<div class="sub mac">' + esc(device.mac) + "</div></div></div>" +
    '<button type="button" class="btn ghost dialog-close">Закрыть</button>' +
    "</div>" +
    '<div class="device-dialog-body">' +
    '<div class="device-metrics">' +
    metric("сигнал", signal) +
    metric("трафик за 5 мин", traffic) +
    metric("сейчас", isHome ? "дома" : "нет") +
    metric("подключение", device.link === "wired" ? "кабель" : "Wi-Fi") +
    "</div>" +
    '<div class="device-identity">' +
    identityRow("Человек", device.person || "—") +
    identityRow("Комната", device.room || "—") +
    identityRow("Тип", device.kind || "—") +
    identityRow("Точка", device.bss_name || device.bss || "—") +
    identityRow("IP", device.ip || "—") +
    identityRow("Имя", device.hostname || "—") +
    identityRow(
      isHome ? "Дома с" : "Последний раз",
      isHome
        ? device.since
          ? clock(device.since) + " · " + ago(localNow - device.since)
          : "—"
        : device.last_seen
          ? clock(device.last_seen) + " · " + ago(localNow - device.last_seen) + " назад"
          : "—",
    ) +
    "</div>" +
    '<section class="detail-section"><h4>Сигнал за 24 часа</h4>' +
    '<div class="detail-signal"><p class="muted">Загрузка…</p></div></section>' +
    '<section class="detail-section"><h4>Трафик за 24 часа</h4>' +
    '<div class="detail-traffic"><p class="muted">Загрузка…</p></div></section>' +
    '<section class="detail-section"><h4>Присутствие сегодня</h4>' +
    '<div class="detail-timeline"><p class="muted">Загрузка…</p></div></section>' +
    "</div>";

  view.querySelector(".dialog-close").addEventListener("click", () => view.close());
  if (typeof view.showModal === "function" && !view.open) view.showModal();
  else view.setAttribute("open", "");

  const from = device.since || localNow - 86400;
  loadSignal(view.querySelector(".detail-signal"), device.mac, from, localNow);
  loadTraffic(view.querySelector(".detail-traffic"), device.mac, from, localNow);
  loadTimeline(view.querySelector(".detail-timeline"), device.mac);
}
