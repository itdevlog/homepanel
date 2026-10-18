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
