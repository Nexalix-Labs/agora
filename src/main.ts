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
  eq?: boolean;        // рисовать " =" после имени (калькулятор/курсы)
  value?: number;
  display?: string;
  copyText?: string;   // что копировать по Enter (по умолчанию value)
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
  wxCity: string;
  wxLoc: { lat: number; lon: number; city: string } | null;
  plugins: { calc: boolean; syscmd: boolean; web: boolean; files: boolean; crypto: boolean; weather: boolean };
}
const DEF: Settings = {
  lang: resolveLang(), hotkey: "Alt+Space", tray: true, theme: "dark", accent: "#0098EA",
  density: "cozy", blur: true, recent: false, autoupdate: true, channel: "stable", wxCity: "", wxLoc: null,
  plugins: { calc: true, syscmd: true, web: true, files: true, crypto: true, weather: true },
};
let SET: Settings = { ...DEF, plugins: { ...DEF.plugins } };

// null вне Tauri (рендер страницы в браузере) — оконные вызовы становятся no-op.
const appWin = (() => { try { return getCurrentWindow(); } catch { return null; } })();
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
  coin:   S('<circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.5-.8-1.5-1.4-2.8-1.4-1.7 0-2.8.9-2.8 2.1 0 2.8 5.8 1.4 5.8 4.2 0 1.2-1.1 2.1-3 2.1-1.4 0-2.5-.6-3-1.5M12 5.8v1.9M12 16.3v1.9"/>'),
  sun:    S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
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
      return { name: s, sub: "", kind: "answer", icon: "calc", answer: true, eq: true, value: out, display: out.toLocaleString("en-US") };
    }
  } catch { /* не выражение */ }
  return null;
}

/* ============================ CRYPTO RATES ============================ */
// Без хардкода: тикер резолвится через CoinGecko /search — есть такая монета
// (включая новые и переименованные) -> тянется цена, нет -> строки нет.
// symCache: слово -> монета | null («проверяли, не монета») — на всю сессию,
// чтобы обычные слова-запросы не дёргали API повторно. Резолв с дебаунсом.
interface Coin { id: string; sym: string; name: string }
const symCache = new Map<string, Coin | null>();
const resolving = new Set<string>();
let resolveT: ReturnType<typeof setTimeout> | null = null;

const priceCache = new Map<string, { usd: number; rub: number; t: number }>();
const priceInFlight = new Set<string>();

const fmtMoney = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 6 : 2 });

async function resolveSymbol(word: string) {
  if (resolving.has(word)) return;
  resolving.add(word);
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/search?query=" + encodeURIComponent(word));
    const j = await r.json();
    const coins: { id: string; symbol?: string; name?: string; market_cap_rank?: number }[] = j?.coins ?? [];
    const rank = (c: { market_cap_rank?: number }) => c.market_cap_rank ?? 1e9;
    const pick = (arr: typeof coins) => arr.sort((a, b) => rank(a) - rank(b))[0];
    // точное совпадение тикера приоритетнее, затем точное имя (напр. "bitcoin")
    const hit =
      pick(coins.filter(c => (c.symbol ?? "").toLowerCase() === word)) ??
      pick(coins.filter(c => (c.name ?? "").toLowerCase() === word));
    symCache.set(word, hit ? { id: hit.id, sym: (hit.symbol ?? word).toUpperCase(), name: hit.name ?? "" } : null);
    if (hit) build(q.value);
  } catch { /* сеть/лимит — не кэшируем отрицательно, попробуем ещё раз */ }
  finally { resolving.delete(word); }
}

async function fetchPrice(id: string) {
  priceInFlight.add(id);
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=" + id + "&vs_currencies=usd,rub",
    );
    const j = await r.json();
    if (j?.[id]?.usd) {
      priceCache.set(id, { usd: j[id].usd, rub: j[id].rub ?? 0, t: Date.now() });
      // Цена долетела — перерисовываем, если запрос всё ещё крипто-строка.
      build(q.value);
    }
  } catch { /* сеть/лимит — строка останется с "…" или устаревшим кэшем */ }
  finally { priceInFlight.delete(id); }
}

function parseCrypto(query: string): { amount: number; word: string; hasAmount: boolean } | null {
  const s = query.trim().toLowerCase();
  let m = s.match(/^(\d+(?:[.,]\d+)?)\s+([a-z0-9]{2,10})$/);
  if (m) return { amount: parseFloat(m[1].replace(",", ".")), word: m[2], hasAmount: true };
  m = s.match(/^(?=.*[a-z])([a-z0-9]{2,10})$/);
  if (m) return { amount: 1, word: m[1], hasAmount: false };
  return null;
}

function tryCrypto(query: string): Entry | null {
  const p0 = parseCrypto(query);
  if (!p0 || !isFinite(p0.amount)) return null;
  const { word, amount, hasAmount } = p0;

  if (!symCache.has(word)) {
    // Незнакомое слово — резолвим после паузы ввода, строку пока не показываем.
    if (resolveT) clearTimeout(resolveT);
    resolveT = setTimeout(() => {
      if (parseCrypto(q.value)?.word === word) resolveSymbol(word);
    }, 350);
    return null;
  }
  const coin = symCache.get(word);
  if (!coin) return null;

  const p = priceCache.get(coin.id);
  const stale = !p || Date.now() - p.t > 30_000;
  if (stale && !priceInFlight.has(coin.id)) fetchPrice(coin.id);
  const label = (hasAmount ? amount + " " : "") + coin.sym;
  if (!p) {
    return { name: label, sub: coin.name + " · CoinGecko", kind: "answer", icon: "coin", answer: true, eq: true, value: 0, display: "…" };
  }
  const usd = amount * p.usd;
  return {
    name: label,
    sub: coin.name + " · ≈ " + fmtMoney(amount * p.rub) + " RUB · CoinGecko",
    kind: "answer", icon: "coin", answer: true, eq: true,
    value: usd, display: "$" + fmtMoney(usd),
  };
}

/* ============================ WEATHER ============================ */
// «погода» / «weather berlin» на любом языке интерфейса. Open-Meteo без ключа.
// Локация: город из запроса > город из настроек > IP. Кэш прогноза 10 мин.
const WX_WORDS = new Set([
  "weather", "погода", "wetter", "météo", "meteo", "tiempo", "clima", "pogoda",
  "hava", "天气", "天氣", "天気", "날씨", "طقس", "هوا", "cuaca", "मौसम",
]);
interface WxLoc { lat: number; lon: number; city: string }
interface WxData {
  temp: number; code: number; wind: number; tmax: number; tmin: number;
  morn: number | null; day: number | null; eve: number | null; precip: number | null;
}
const geoCache = new Map<string, WxLoc | null>();
const geoBusy = new Set<string>();
const wxCache = new Map<string, { t: number; d: WxData }>();
const wxBusy = new Set<string>();
let wxT: ReturnType<typeof setTimeout> | null = null;

function wxCond(code: number): string {
  const k =
    code === 0 ? "wx_clear" :
    code <= 2 ? "wx_partly" :
    code === 3 ? "wx_cloudy" :
    code <= 48 ? "wx_fog" :
    code <= 57 ? "wx_drizzle" :
    code <= 67 ? "wx_rain" :
    code <= 77 ? "wx_snow" :
    code <= 82 ? "wx_rain" :
    code <= 86 ? "wx_snow" : "wx_storm";
  return t(SET.lang, k as Parameters<typeof t>[1]);
}
const deg = (v: number) => (v > 0 ? "+" : "") + Math.round(v) + "°";

async function fetchGeo(city: string) {
  geoBusy.add(city);
  try {
    const j = await (await fetch(
      "https://geocoding-api.open-meteo.com/v1/search?count=1&language=" + SET.lang + "&name=" + encodeURIComponent(city),
    )).json();
    const r = j?.results?.[0];
    geoCache.set(city, r ? { lat: r.latitude, lon: r.longitude, city: r.name } : null);
    if (r) build(q.value);
  } catch { /* не кэшируем отрицательно */ }
  finally { geoBusy.delete(city); }
}

async function fetchWx(loc: WxLoc) {
  const key = loc.lat.toFixed(2) + "," + loc.lon.toFixed(2);
  wxBusy.add(key);
  try {
    const j = await (await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=" + loc.lat + "&longitude=" + loc.lon +
      "&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min" +
      "&hourly=temperature_2m,precipitation_probability" +
      "&wind_speed_unit=ms&timezone=auto&forecast_days=1",
    )).json();
    if (j?.current) {
      // Часы локальные (timezone=auto): срезы утро 09:00 / день 15:00 / вечер 21:00.
      const at = (hh: string): number | null => {
        const i = (j.hourly?.time ?? []).findIndex((s: string) => s.endsWith("T" + hh));
        return i >= 0 ? j.hourly.temperature_2m?.[i] ?? null : null;
      };
      const probs: number[] = j.hourly?.precipitation_probability ?? [];
      wxCache.set(key, {
        t: Date.now(),
        d: {
          temp: j.current.temperature_2m, code: j.current.weather_code, wind: j.current.wind_speed_10m,
          tmax: j.daily?.temperature_2m_max?.[0] ?? j.current.temperature_2m,
          tmin: j.daily?.temperature_2m_min?.[0] ?? j.current.temperature_2m,
          morn: at("09:00"), day: at("15:00"), eve: at("21:00"),
          precip: probs.length ? Math.max(...probs) : null,
        },
      });
      build(q.value);
    }
  } catch { /* сеть */ }
  finally { wxBusy.delete(key); }
}

function tryWeather(query: string): Entry[] | null {
  const parts = query.trim().toLowerCase().split(/\s+/);
  if (!parts.length || !WX_WORDS.has(parts[0])) return null;
  // Только явный город: из запроса или из настроек. Никакого гео по IP —
  // ничего не звоним без запроса пользователя.
  const cityArg = parts.slice(1).join(" ");
  let loc: WxLoc | null = null;
  if (!cityArg && SET.wxLoc) {
    // город выбран в настройках из саджеста — координаты уже известны
    loc = SET.wxLoc;
  } else {
    const cityQ = cityArg || SET.wxCity.trim().toLowerCase();
    if (!cityQ) {
      return [{ name: t(SET.lang, "wx_nocity"), sub: "Open-Meteo", kind: "action", icon: "sun", actionId: "settings" }];
    }
    if (!geoCache.has(cityQ)) {
      if (wxT) clearTimeout(wxT);
      wxT = setTimeout(() => { if (!geoBusy.has(cityQ)) fetchGeo(cityQ); }, 350);
    }
    loc = geoCache.get(cityQ) ?? null;
    if (geoCache.has(cityQ) && !loc) return null; // город не нашёлся
    if (!loc) return [{ name: "…", sub: "Open-Meteo", kind: "answer", icon: "sun", answer: true, value: 0, display: "…" }];
  }

  // 2) прогноз
  const key = loc.lat.toFixed(2) + "," + loc.lon.toFixed(2);
  const w = wxCache.get(key);
  const stale = !w || Date.now() - w.t > 600_000;
  if (stale && !wxBusy.has(key)) fetchWx(loc);
  if (!w) {
    return [{ name: loc.city, sub: "Open-Meteo", kind: "answer", icon: "sun", answer: true, value: 0, display: "…" }];
  }

  const L = SET.lang;
  const d = w.d;
  const dayline = [
    d.morn != null ? t(L, "wx_morn") + " " + deg(d.morn) : "",
    d.day != null ? t(L, "wx_day") + " " + deg(d.day) : "",
    d.eve != null ? t(L, "wx_eve") + " " + deg(d.eve) : "",
    d.precip != null ? t(L, "wx_precip") + " " + Math.round(d.precip) + "%" : "",
  ].filter(Boolean).join(" · ");
  const range = t(L, "wx_high") + " " + deg(d.tmax) + " · " + t(L, "wx_low") + " " + deg(d.tmin) +
    " · " + t(L, "wx_wind") + " " + Math.round(d.wind) + " " + t(L, "wx_ms");
  const summary = deg(d.temp) + " " + loc.city + " — " + wxCond(d.code) + " (" + range + (dayline ? " · " + dayline : "") + ")";
  return [
    {
      name: loc.city + " — " + wxCond(d.code),
      sub: "", kind: "answer", icon: "sun", answer: true,
      value: 0, display: deg(d.temp), copyText: summary,
    },
    {
      name: range,
      sub: "", kind: "answer", icon: "sun", answer: true,
      value: 0, display: "", copyText: summary,
    },
    ...(dayline ? [{
      name: dayline,
      sub: "", kind: "answer" as const, icon: "sun" as const, answer: true,
      value: 0, display: "", copyText: summary,
    }] : []),
  ];
}

/* ============================ RENDER (flat, quiet) ============================ */
function build(query: string) {
  const rows: Entry[] = [];
  const calc = SET.plugins.calc ? tryCalc(query) : null;
  if (calc) rows.push(calc);
  const wx = !calc && SET.plugins.weather ? tryWeather(query) : null;
  if (wx) rows.push(...wx);
  const crypto = !calc && !wx && SET.plugins.crypto ? tryCrypto(query) : null;
  if (crypto) rows.push(crypto);

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
    if (!calc && !wx && !crypto && SET.plugins.web) {
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
    const nameHtml = o.answer && o.eq ? esc(o.name) + " =" : o.answer ? esc(o.name) : highlight(o.name, query);
    const tail = o.answer
      ? (o.display ? '<span class="answer-val">' + esc(o.display) + '</span>' : '')
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
    appWin?.setSize(new LogicalSize(WIN_W, Math.ceil(h))).catch(() => {});
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
  await appWin?.hide().catch(() => {});
  q.value = "";
  build("");
}

async function run(o: Entry) {
  if (!o) return;
  if (o.answer) {
    try { await navigator.clipboard.writeText(o.copyText ?? String(o.value)); } catch { /* нет фокуса — не критично */ }
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

// Автофокус по наведению: навёл мышь на панель — печатай сразу, клик не нужен.
launcher.addEventListener("mouseenter", () => {
  if (!document.hasFocus()) appWin?.setFocus().catch(() => {});
  q.focus();
});

// Окно показано по хоткею — фокус, выделение, свежий каталог.
listen("focus-input", () => {
  q.focus();
  q.select();
  refreshCatalog();
});

// Настройки поменялись в окне настроек — применяем вживую.
listen("settings-changed", (e) => applySettings(e.payload));

/* ============================ INIT ============================ */
// Демо-режим для промо-скриншотов (headless-рендер вне Tauri):
//   ?demo=1        — фейковый каталог приложений/файлов (реальные иконки без Tauri недоступны)
//   ?q=<запрос>    — подставить запрос и отрисовать
//   ?theme=light   — светлая тема
//   ?lang=en       — язык интерфейса предпросмотра
// В обычном запуске (без query) не задействован.
const demo = new URLSearchParams(location.search);
if (demo.get("demo") === "1") {
  const A = (name: string, sub: string): Entry => ({ name, sub, kind: "app", icon: "app" });
  APPS = [
    A("Visual Studio Code", "Applications"), A("Figma", "Applications"),
    A("Telegram", "Applications"), A("Spotify", "Applications"),
    A("Photoshop", "Applications"), A("Steam", "Applications"),
  ];
  FILES = [
    { name: "roadmap-q3.md", sub: "~/nexalix/docs", kind: "file", icon: "file" },
    { name: "brand-tokens.json", sub: "~/nexalix/design", kind: "file", icon: "file" },
  ];
}
if (demo.get("theme") === "light") document.body.classList.add("light");
// Фирменный тёмный фон для промо-скриншотов (в Tauri окно прозрачное).
if (demo.has("demo") || demo.has("q")) {
  document.body.style.background = document.body.classList.contains("light")
    ? "radial-gradient(ellipse 70% 60% at 30% 10%, rgba(0,152,234,0.10), transparent 55%), #EEF1F5"
    : "radial-gradient(ellipse 70% 60% at 25% 8%, rgba(0,152,234,0.14), transparent 55%), radial-gradient(ellipse 60% 55% at 85% 95%, rgba(0,200,150,0.06), transparent 60%), #0A0C0F";
  document.body.style.padding = "80px 96px";
}
const demoQ = demo.get("q") ?? "";
const demoLang = demo.get("lang");

if (demoQ) q.value = demoQ;
if (demoLang || demoQ || demo.has("demo")) {
  // Демо: применяем настройки синхронно (с опц. языком), без чтения из Tauri.
  applySettings(demoLang ? { lang: demoLang } : {});
} else {
  invoke("get_settings").then(applySettings).catch(() => applySettings({}));
}
build(demoQ);
q.focus();
if (!demo.has("demo") && !demoQ) refreshCatalog();
