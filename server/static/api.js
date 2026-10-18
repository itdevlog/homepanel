/** Тонкие обёртки над JSON-API сервера. */

async function request(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }
  if (!response.ok) {
    const message =
      (data && data.error && data.error.message) || response.statusText || "Ошибка запроса";
    throw new Error(message);
  }
  return data;
}

export function getJSON(path) {
  return request(path, { method: "GET" });
}

export function postJSON(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getState() {
  return getJSON("/api/state");
}

export function getDevices() {
  return getJSON("/api/devices");
}

export function getEvents(sinceId) {
  const since = sinceId == null ? 0 : sinceId;
  return getJSON("/api/events?since=" + encodeURIComponent(since));
}

export function getStats({ group = "day", from, to, mac, person } = {}) {
  const params = new URLSearchParams({ group });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (mac) params.set("mac", mac);
  if (person) params.set("person", person);
  return getJSON("/api/stats?" + params.toString());
}
