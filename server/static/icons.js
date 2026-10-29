/** Набор контурных SVG-иконок. Без зависимостей: строки для innerHTML. */

const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>',
  devices:
    '<rect x="3" y="4" width="13" height="10" rx="2"/><path d="M7 20h12V9"/><path d="M7 20h5"/>',
  history:
    '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/>',
  analytics:
    '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  router:
    '<rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 17h.01M10 17h.01"/><path d="M17 9a7 7 0 0 0-10 0"/><path d="M19.5 6.5a11 11 0 0 0-15 0"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/>',
  signal: '<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m5 6 1 15h12l1-15"/><path d="M10 11v6M14 11v6"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  power: '<path d="M12 3v9"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  merge: '<path d="M8 3v5a4 4 0 0 0 4 4h8"/><path d="M16 3v5a4 4 0 0 1-4 4H4"/><path d="m17 9 3 3-3 3"/><path d="m7 15-3 3 3 3"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M3 21v-5h5M21 3v5h-5"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M4 3h16"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M10.3 3.9 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  room: '<path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/><path d="M9 21v-6h6v6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  tv: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8M12 18v4"/>',
  smartphone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  laptop: '<path d="M5 5h14v11H5z"/><path d="M2 19h20l-2-3H4z"/>',
  tablet: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/>',
  desktop: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  light: '<path d="M9 18h6M10 22h4"/><path d="M8.5 14.5a6 6 0 1 1 7 0c-.9.8-1.5 1.5-1.5 2.5h-4c0-1-.6-1.7-1.5-2.5z"/>',
  vacuum: '<circle cx="12" cy="13" r="8"/><circle cx="12" cy="13" r="2"/><path d="M8 5h8"/><path d="M12 3v2"/>',
  camera: '<path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v11H3V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>',
  speaker: '<rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><circle cx="12" cy="6" r="1"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 17v4h12v-4"/>',
  watch: '<circle cx="12" cy="12" r="6"/><path d="M9 2h6l1 4H8zM8 18h8l-1 4H9z"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  other: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5M12 17h.01"/>',
  device: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9M17 6l3 3M14 9l3 3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3M6.6 6.6C3.7 8.5 2 12 2 12s3.5 7 10 7c1.5 0 2.8-.3 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
};

export function icon(name, className = "") {
  const body = PATHS[name] || PATHS.other;
  return (
    '<svg class="icon' + (className ? " " + className : "") +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>"
  );
}

const KIND_ICON = {
  phone: "smartphone",
  smartphone: "smartphone",
  laptop: "laptop",
  tablet: "tablet",
  tv: "tv",
  iot: "cpu",
  light: "light",
  vacuum: "vacuum",
  router: "router",
  speaker: "speaker",
  camera: "camera",
  printer: "printer",
  watch: "watch",
  desktop: "desktop",
  plug: "plug",
  other: "other",
};

/** Иконка устройства по явному icon, затем по kind/role. */
export function deviceIcon(device) {
  if (!device) return "device";
  const explicit = KIND_ICON[device.icon];
  if (explicit) return explicit;
  const kind = KIND_ICON[device.kind];
  if (kind) return kind;
  if (device.role === "infra") return "cpu";
  if (device.link === "wired") return "desktop";
  return "device";
}

export function deviceIconSvg(device, className = "") {
  return icon(deviceIcon(device), className);
}

/** Детерминированный оттенок для аватара человека. */
export function personHue(name) {
  let hash = 0;
  for (const char of String(name || "?")) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

export function initials(name) {
  const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function avatar(name, extraClass = "") {
  return (
    '<span class="avatar' + (extraClass ? " " + extraClass : "") +
    '" style="--avatar-h:' + personHue(name) + '" aria-hidden="true">' +
    initials(name) + "</span>"
  );
}
