/** Страница «Устройства»: реестр, разметка (имя/человек/тип/доверие/скрытие)
 * и объединение MAC-адресов. */

import { postJSON, getDevices } from "../api.js";

const KINDS = [
  ["", "—"],
  ["phone", "Телефон"],
  ["laptop", "Ноутбук"],
  ["tv", "ТВ"],
  ["iot", "Умное устройство"],
  ["other", "Другое"],
];

const TRUSTS = [
  ["unknown", "Неизвестно"],
  ["own", "Свой"],
  ["guest", "Гость"],
];

const HEADERS = [
  "MAC",
  "Имя",
  "Человек",
  "Тип",
  "Доверие",
  "Скрыто",
  "Состояние",
  "IP",
  "Hostname",
  "BSS",
  "Диапазон",
  "dBm",
  "Объединить",
];

let note = null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function options(pairs, selected) {
  return pairs
    .map(
      ([value, label]) =>
        '<option value="' + esc(value) + '"' +
        (value === (selected ?? "") ? " selected" : "") +
        ">" + esc(label) + "</option>",
    )
    .join("");
}

function textInput(field, value) {
  return '<input type="text" name="' + field + '" value="' + esc(value ?? "") + '" maxlength="64">';
}

function mergeOptions(macs) {
  return '<option value="">—</option>' +
    macs.map((mac) => '<option value="' + esc(mac) + '">' + esc(mac) + "</option>").join("");
}

function row(device, macs) {
  const isHome = device.state === "home";
  const weak = device.signal != null && device.signal <= -75;
  return (
    '<tr class="' + (device.trust === "unknown" ? "is-unknown" : "") +
    '" data-mac="' + esc(device.mac) + '">' +
    '<td class="mac">' + esc(device.mac) + "</td>" +
    "<td>" + textInput("name", device.name) + "</td>" +
    "<td>" + textInput("person", device.person) + "</td>" +
    '<td><select name="kind">' + options(KINDS, device.kind || "") + "</select></td>" +
    '<td><select name="trust">' + options(TRUSTS, device.trust || "unknown") + "</select></td>" +
    '<td><input type="checkbox" name="hidden"' + (device.hidden ? " checked" : "") + "></td>" +
    '<td><span class="badge' + (isHome ? " is-home" : "") + '">' +
    (isHome ? "дома" : "нет") + "</span></td>" +
    "<td>" + esc(device.ip || "") + "</td>" +
    "<td>" + esc(device.hostname || "") + "</td>" +
    "<td>" + esc(device.bss || "") + "</td>" +
    "<td>" + esc(device.band || "") + "</td>" +
    '<td class="' + (weak ? "signal-weak" : "") + '">' +
    (device.signal == null ? "" : device.signal) + "</td>" +
    '<td><div class="actions">' +
    '<select class="merge-select">' + mergeOptions(macs.filter((m) => m !== device.mac)) + "</select>" +
    '<button type="button" class="btn merge-btn">Объединить</button>' +
    "</div></td>" +
    "</tr>"
  );
}

function statusHtml() {
  if (!note) return "";
  return '<p class="devices-status ' + (note.error ? "error" : "muted") + '">' +
    esc(note.text) + "</p>";
}

function paint(root, devices) {
  const macs = devices.map((d) => d.mac);
  const body = devices.length
    ? devices.map((d) => row(d, macs)).join("")
    : '<tr><td colspan="' + HEADERS.length + '" class="muted">Устройств пока нет.</td></tr>';
  root.innerHTML =
    statusHtml() +
    "<h2>Устройства</h2>" +
    '<p class="muted">Имя, человек, тип и доверие сохраняются сразу после правки. ' +
    "Отметка «Скрыто» убирает устройство с главной страницы.</p>" +
    '<div class="table-wrap"><table class="device-table"><thead><tr>' +
    HEADERS.map((h) => "<th>" + h + "</th>").join("") +
    "</tr></thead><tbody>" + body + "</tbody></table></div>";
}

function isEditing(root) {
  const el = document.activeElement;
  return Boolean(el && root.contains(el) && (el.tagName === "INPUT" || el.tagName === "SELECT"));
}

function setNote(root, text, error) {
  note = { text, error: Boolean(error) };
  const el = root.querySelector(".devices-status");
  if (el) {
    el.textContent = text;
    el.className = "devices-status " + (error ? "error" : "muted");
  }
}

async function refresh(root) {
  paint(root, await getDevices());
}

async function save(root, payload) {
  try {
    await postJSON("/api/devices", payload);
    setNote(root, "Сохранено.", false);
    await refresh(root);
  } catch (err) {
    setNote(root, err.message, true);
  }
}

async function onFieldChange(root, event) {
  const field = event.target.name;
  if (!field) return;
  const tr = event.target.closest("tr[data-mac]");
  if (!tr) return;
  const value = field === "hidden" ? event.target.checked : event.target.value;
  await save(root, { mac: tr.dataset.mac, [field]: value });
}

async function onButtonClick(root, event) {
  const btn = event.target.closest("button");
  if (!btn || !btn.classList.contains("merge-btn")) return;
  const tr = btn.closest("tr[data-mac]");
  if (!tr) return;
  const target = tr.querySelector(".merge-select").value;
  if (!target) {
    setNote(root, "Выберите устройство для объединения.", true);
    return;
  }
  if (!confirm("Объединить " + tr.dataset.mac + " с " + target + "?")) return;
  await save(root, { mac: tr.dataset.mac, mergeInto: target });
}

export function render(root, state) {
  root.onchange = (event) => onFieldChange(root, event);
  root.onclick = (event) => onButtonClick(root, event);
  if (isEditing(root)) return; // не перерисовываем, пока пользователь правит поле
  paint(root, state.devices || []);
}
