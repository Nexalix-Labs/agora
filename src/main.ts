import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { RTL, t, resolveLang } from "./i18n";

/* ============================ TYPES ============================ */
interface Entry {
  name: string;
  sub: string;
  kind: string;        // app | file | folder | action | search | answer
  icon: keyof typeof I;
  path?: string;       // для app/file — что запускать
  keywords?: string;   // скрытая строка для поиска (латинский AppID)
  actionId?: string;   // для action — команда в Rust
  url?: string;        // для web-поиска
  answer?: boolean;
  value?: number;
  display?: string;
}

interface Settings {
  lang: string;
  hotkey: string;
  tray: boolean;
  theme: "system" | "dark" | "light";
  accent: string;
  density: "compact" | "cozy";
  blur: boolean;
  recent: boolean;
  autoupdate: boolean;
  channel: string;
  plugins: { calc: boolean; syscmd: boolean; web: boolean; files: boolean };
}
const DEF: Settings = {
  lang: resolveLang(), hotkey: "Alt+Space", tray: true, theme: "dark", accent: "#0098EA",
  density: "cozy", blur: true, recent: false, autoupdate: true, channel: "stable",
  plugins: { calc: true, syscmd: true, web: true, files: true },
};
let SET: Settings = { ...DEF, plugins: { ...DEF.plugins } };

const appWin = getCurrentWindow();
const WIN_W = 784; // 640 панель + 2×72 поля под тени

/* ============================ ICONS ============================ */
const S = (p: string, w = 1.6) =>
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
const I = {
  app:    S('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'),
  file:   S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  folder: S('<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>'),
  web:    S('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>'),
  calc:   S('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>'),
  power:  S('<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>'),
  trash:  S('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  moon:   S('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>'),
  lock:   S('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  gear:   S('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
};

/* ============================ CATALOG ============================ */
let APPS: Entry[] = [];
let FILES: Entry[] = [];

const ACTIONS: Entry[] = [
  { name:'Toggle Dark Mode', sub:'Appearance', kind:'action', icon:'moon',  actionId:'dark_mode' },
  { name:'Empty Trash',      sub:'Storage',    kind:'action', icon:'trash', actionId:'empty_trash' },
  { name:'Sleep',            sub:'Power',      kind:'action', icon:'power', actionId:'sleep' },
  { name:'Lock Screen',      sub:'Power',      kind:'action', icon:'lock',  actionId:'lock' },
];
const SETTINGS_ACTION: Entry =
  { name:'Agora Settings', sub:'Preferences', kind:'action', icon:'gear', actionId:'settings' };

async function refreshCatalog() {
  try {
    const [apps, files] = await Promise.all([
      invoke<Entry[]>("index_apps"),
      invoke<Entry[]>("recent_files"),
    ]);
    APPS = apps.map(a => ({ ...a, kind: "app", icon: "app" as const }));
    FILES = files.map(f => ({ ...f, kind: "file", icon: "file" as const }));
  } catch (e) {
    console.error("catalog:", e);
  }
  build(q.value);
}

/* ============================ HELPERS ============================ */
const q = document.querySelector<HTMLInputElement>("#q")!;
const results = document.querySelector<HTMLDivElement>("#results")!;
const launcher = document.querySelector<HTMLDivElement>("#launcher")!;
const divider = document.querySelector<HTMLDivElement>("#divider")!;
let items: { el: HTMLElement; data: Entry }[] = [];
let active = 0;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function highlight(name: string, query: string): string {
  if (!query) return esc(name);
  const i = name.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return esc(name);
  return esc(name.slice(0, i)) + '<span class="hl">' + esc(name.slice(i, i + query.length)) + '</span>' + esc(name.slice(i + query.length));
}

function score(name: string, query: string): number {
  const n = name.toLowerCase(), s = query.toLowerCase();
  if (!s) return 1;
  if (n.startsWith(s)) return 3;
  if (n.includes(s)) return 2;
  let i = 0;
  for (const ch of n) { if (ch === s[i]) i++; if (i === s.length) return 1; }
  return 0;
}

// Матч по видимому имени ИЛИ по скрытым keywords (латинский AppID) — чтобы
// локализованные имена находились латиницей. keywords-совпадение чуть слабее.
function scoreEntry(o: Entry, query: string): number {
  const byName = score(o.name, query);
  if (!query || !o.keywords) return byName;
  const byKw = score(o.keywords, query);
  return Math.max(byName, byKw > 0 ? byKw - 0.5 : 0);
}

/* ============================ CALCULATOR ============================ */
function tryCalc(query: string): Entry | null {
  const s = query.trim();
  if (!/^[-+*/().\d\s%^,]+$/.test(s) || !/[-+*/^%]/.test(s) || !/\d/.test(s)) return null;
  try {
    // Запятая = десятичный разделитель (русская раскладка): 59,7 -> 59.7
    const expr = s.replace(/,/g, ".").replace(/\^/g, "**").replace(/%/g, "/100");
    const val = Function('"use strict";return (' + expr + ')')();
    if (typeof val === "number" && isFinite(val)) {
      const out = Math.round(val * 1e8) / 1e8;
      return { name: s, sub: "", kind: "answer", icon: "calc", answer: true, value: out, display: out.toLocaleString("en-US") };
    }
  } catch { /* не выражение */ }
  return null;
}

/* ============================ RENDER (flat, quiet) ============================ */
function build(query: string) {
  const rows: Entry[] = [];
  const calc = SET.plugins.calc ? tryCalc(query) : null;
  if (calc) rows.push(calc);

  if (!query.trim()) {
    // Пустой запрос — по умолчанию пустая панель, ничего не навязываем.
    // Недавние — только если включено в настройках (Show recent on open).
    if (SET.recent && SET.plugins.files) rows.push(...FILES.slice(0, 6));
  } else {
    const pool: Entry[] = [
      ...APPS,
      ...(SET.plugins.files ? FILES : []),
      ...(SET.plugins.syscmd ? ACTIONS : []),
      SETTINGS_ACTION,
    ];
    pool
      .map(o => ({ o, sc: scoreEntry(o, query) }))
      .filter(x => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 14)
      .forEach(x => rows.push(x.o));
    if (!calc && SET.plugins.web) {
      rows.push({
        name: t(SET.lang, "web_for").replace("{q}", query.trim()), sub: "Google", kind: "search", icon: "web",
        url: "https://www.google.com/search?q=" + encodeURIComponent(query.trim()),
      });
    }
  }

  results.innerHTML = "";
  items = [];
  divider.style.display = rows.length ? "" : "none";
  rows.forEach(o => {
    const idx = items.length;
    const row = document.createElement("div");
    row.className = "row" + (o.answer ? " answer" : "");
    row.setAttribute("role", "option");
    // Реальная иконка уже в кэше — рисуем <img> сразу (без мигания при вводе).
    const cached = o.path ? iconCache.get(o.path) : undefined;
    const glyphInner = cached ? '<img alt="" src="' + cached + '">' : I[o.icon];
    const nameHtml = o.answer ? esc(o.name) + " =" : highlight(o.name, query);
    const tail = o.answer
      ? '<span class="answer-val">' + esc(o.display!) + '</span>'
      : (o.sub ? '<span class="tail">' + esc(o.sub) + '</span>' : '');
    row.innerHTML = '<span class="glyph">' + glyphInner + '</span><span class="name">' + nameHtml + '</span>' + tail;
    row.addEventListener("mousemove", () => setActive(idx));
    row.addEventListener("click", () => { setActive(idx); run(o); });
    results.appendChild(row);
    items.push({ el: row, data: o });
    // Иконку ещё не пробовали достать (и не тянем прямо сейчас) — тянем асинхронно.
    if (o.path && !iconCache.has(o.path) && !inFlight.has(o.path)) {
      ensureIcon(o.path);
    }
  });
  setActive(0);
  fitWindow();
}

function setActive(i: number) {
  if (!items.length) return;
  active = Math.max(0, Math.min(i, items.length - 1));
  items.forEach((it, idx) => it.el.classList.toggle("active", idx === active));
  const el = items[active].el;
  const r = el.getBoundingClientRect(), c = results.getBoundingClientRect();
  if (r.bottom > c.bottom) results.scrollTop += r.bottom - c.bottom + 8;
  else if (r.top < c.top) results.scrollTop -= c.top - r.top + 8;
}

/* Высота окна тянется за контентом панели (+ поля под тени). */
function fitWindow() {
  requestAnimationFrame(() => {
    const h = launcher.getBoundingClientRect().height + 144;
    appWin.setSize(new LogicalSize(WIN_W, Math.ceil(h))).catch(() => {});
  });
}

/* ============================ SETTINGS ============================ */
const systemLight = window.matchMedia("(prefers-color-scheme: light)");

function applyTheme() {
  let t: string = SET.theme;
  if (t === "system") t = systemLight.matches ? "light" : "dark";
  document.body.classList.toggle("light", t === "light");
}
systemLight.addEventListener("change", () => { if (SET.theme === "system") applyTheme(); });

function applySettings(v: unknown) {
  const s = (v && typeof v === "object" ? v : {}) as Partial<Settings>;
  SET = { ...DEF, ...s, plugins: { ...DEF.plugins, ...(s.plugins ?? {}) } };
  if (!SET.lang) SET.lang = resolveLang();
  document.documentElement.style.setProperty("--accent", SET.accent);
  document.documentElement.style.setProperty("--accent-hi", SET.accent);
  applyTheme();
  launcher.classList.toggle("compact", SET.density === "compact");
  launcher.classList.toggle("noblur", !SET.blur);
  // Локализация статичного UI лаунчера.
  document.documentElement.dir = RTL.has(SET.lang) ? "rtl" : "ltr";
  q.placeholder = t(SET.lang, "search_ph");
  const open = document.querySelector<HTMLElement>("#hintOpen");
  if (open) open.textContent = t(SET.lang, "hint_open");
  build(q.value);
}

/* ============================ ICONS (real) ============================ */
// path -> data-uri | null(«пробовали, нет иконки»). Живёт всю сессию,
// чтобы при каждом нажатии клавиши не дёргать Rust заново.
const iconCache = new Map<string, string | null>();
// Пути с запросом «в полёте» — чтобы перерисовки при вводе не дёргали Rust повторно.
const inFlight = new Set<string>();

// Подставить иконку во ВСЕ сейчас видимые строки этого пути (а не в захваченный
// элемент — его могло смыть перерисовкой, пока запрос летел).
function applyIcon(path: string, uri: string) {
  for (const it of items) {
    if (it.data.path !== path) continue;
    const span = it.el.querySelector<HTMLElement>(".glyph");
    if (span && !span.querySelector("img")) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = uri;
      span.replaceChildren(img);
    }
  }
}

async function ensureIcon(path: string) {
  inFlight.add(path);
  try {
    const uri = await invoke<string | null>("app_icon", { path });
    iconCache.set(path, uri ?? null);
    if (uri) applyIcon(path, uri);
  } catch {
    iconCache.set(path, null);
  } finally {
    inFlight.delete(path);
  }
}

/* ============================ TOAST ============================ */
let toastT: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string) {
  let t = document.querySelector<HTMLDivElement>("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.innerHTML = '<span class="dot"></span>' + esc(msg);
  requestAnimationFrame(() => t!.classList.add("on"));
  if (toastT) clearTimeout(toastT);
  toastT = setTimeout(() => t!.classList.remove("on"), 1600);
}

/* ============================ RUN ============================ */
async function hideAndReset() {
  await appWin.hide().catch(() => {});
  q.value = "";
  build("");
}

async function run(o: Entry) {
  if (!o) return;
  if (o.answer) {
    try { await navigator.clipboard.writeText(String(o.value)); } catch { /* нет фокуса — не критично */ }
    toast(t(SET.lang, "copied") + "  " + o.display);
    return;
  }
  try {
    if (o.url) {
      await invoke("open_url", { url: o.url });
    } else if (o.actionId) {
      const msg = await invoke<string>("run_action", { id: o.actionId });
      if (o.actionId === "dark_mode" || o.actionId === "empty_trash") {
        toast(msg);
        return; // остаёмся видимыми, показываем результат
      }
    } else if (o.path) {
      await invoke("open_path", { path: o.path });
    }
    await hideAndReset();
  } catch (e) {
    toast(String(e));
  }
}

/* ============================ EVENTS ============================ */
q.addEventListener("input", () => build(q.value));
q.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
  else if (e.key === "Enter") { e.preventDefault(); if (items[active]) run(items[active].data); }
  else if (e.key === "Escape") {
    e.preventDefault();
    if (q.value) { q.value = ""; build(""); } else hideAndReset();
  }
  else if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    const n = +e.key - 1;
    if (items[n]) { setActive(n); run(items[n].data); }
  }
});
document.addEventListener("click", () => q.focus());

// Окно показано по хоткею — фокус, выделение, свежий каталог.
listen("focus-input", () => {
  q.focus();
  q.select();
  refreshCatalog();
});

// Настройки поменялись в окне настроек — применяем вживую.
listen("settings-changed", (e) => applySettings(e.payload));

/* ============================ INIT ============================ */
invoke("get_settings").then(applySettings).catch(() => applySettings({}));
build("");
q.focus();
refreshCatalog();
