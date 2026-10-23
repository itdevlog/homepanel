// Чистые помощники панели: без DOM и без fetch — тестируются в Node.
// (см. docs/superpowers/specs/2026-10-18-homepanel-design.md, §12)

/**
 * Человекочитаемая длительность. Незначащие части опускаются:
 * 0 -> "0 мин", 5400 -> "1 ч 30 мин", 93600 -> "1 д 2 ч".
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0) parts.push(`${hours} ч`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} мин`);
  return parts.join(" ");
}

/**
 * Группировка устройств по человеку. `home` истинно, только если у человека
 * есть не скрытое устройство в состоянии "home"; `since` — минимальный `since`
 * среди таких устройств. Люди без устройств не появляются; скрытые устройства
 * не дают `home`, но их человек в списке остаётся. Порядок: «дома» вперёд,
 * внутри группы — по первому появлению.
 * @param {object[]} devices
 * @returns {object[]}
 */
export function groupPeople(devices) {
  const order = [];
  const byPerson = new Map();

  for (const device of devices || []) {
    const person = device.person;
    if (!person) continue;

    let entry = byPerson.get(person);
    if (!entry) {
      entry = { person, home: false, since: null, devices: [] };
      byPerson.set(person, entry);
      order.push(entry);
    }
    entry.devices.push(device);

    if (device.state === "home" && !device.hidden) {
      entry.home = true;
      const since = Number(device.since);
      if (Number.isFinite(since) && (entry.since === null || since < entry.since)) {
        entry.since = since;
      }
    }
  }

  // sort — стабильная сортировка: равные сохраняют порядок добавления.
  return order.slice().sort((a, b) => (a.home === b.home ? 0 : a.home ? -1 : 1));
}

/**
 * События, появившиеся после последнего известного id.
 * @param {object[]} events
 * @param {number} lastId
 * @returns {object[]}
 */
export function diffEvents(events, lastId) {
  const threshold = Number(lastId) || 0;
  return (events || []).filter((event) => Number(event.id) > threshold);
}

/**
 * Преобразование агрегатов /api/stats в столбцы графика.
 * @param {object[]} rows
 * @returns {{label: string, value: number}[]}
 */
export function barsFromStats(rows) {
  return (rows || []).map((row) => ({
    label: String(row.bucket),
    value: Number(row.minutes) || 0,
  }));
}

/**
 * «Неопознанное» устройство: без имени, без человека и не скрытое.
 * (Скрытое или уже размеченное неопознанным не считается — ревью I3.)
 * @param {object} device
 * @returns {boolean}
 */
export function isUnidentified(device) {
  if (!device) return false;
  return !device.name && !device.person && !device.hidden;
}

/**
 * «Сколько назад» с секундной точностью для свежих данных.
 * @param {number} seconds
 * @returns {string}
 */
export function formatAgo(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 5) return "только что";
  if (total < 60) return `${total} с назад`;
  return `${formatDuration(total)} назад`;
}

/**
 * Подпись устройства: имя, человек, реальный hostname (не "*"), иначе MAC.
 * @param {object} device
 * @returns {string}
 */
export function deviceLabel(device) {
  if (!device) return "";
  const hostname = device.hostname && device.hostname !== "*" ? device.hostname : "";
  return device.name || device.person || hostname || device.mac || "";
}

/**
 * Поиск и быстрые фильтры страницы «Устройства».
 * @param {object[]} devices
 * @param {string} query — ищет по MAC, имени, человеку, hostname и IP
 * @param {"all"|"home"|"unknown"|"hidden"} mode
 * @returns {object[]}
 */
export function filterDevices(devices, query, mode = "all") {
  const q = String(query || "").trim().toLowerCase();
  return (devices || []).filter((device) => {
    if (mode === "home" && device.state !== "home") return false;
    if (mode === "hidden" && !device.hidden) return false;
    if (mode === "unknown" && (device.name || device.person)) return false;
    if (!q) return true;
    return [device.mac, device.name, device.person, device.hostname, device.ip]
      .some((value) => value && String(value).toLowerCase().includes(q));
  });
}

function sortValue(device, key) {
  if (key === "signal") {
    if (device.signal == null) return null;
    const dbm = Number(device.signal);
    return Number.isFinite(dbm) ? dbm : null;
  }
  if (key === "state") return device.state === "home" ? 0 : 1;
  if (key === "mac") return device.mac || "";
  return deviceLabel(device);
}

/**
 * Сортировка списка устройств. Пустой сигнал всегда в конце.
 * @param {object[]} devices
 * @param {"name"|"signal"|"state"|"mac"} key
 * @param {"asc"|"desc"} dir
 * @returns {object[]} новый массив
 */
export function sortDevices(devices, key = "name", dir = "asc") {
  const sign = dir === "desc" ? -1 : 1;
  return (devices || []).slice().sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
    return String(av).localeCompare(String(bv), "ru") * sign;
  });
}

/**
 * Уровень сигнала для подкраски: weak при <= -75, fair при <= -65.
 * @param {number|null} signal
 * @returns {"none"|"weak"|"fair"|"good"}
 */
export function signalLevel(signal) {
  if (signal == null || !Number.isFinite(Number(signal))) return "none";
  const dbm = Number(signal);
  if (dbm <= -75) return "weak";
  if (dbm <= -65) return "fair";
  return "good";
}
