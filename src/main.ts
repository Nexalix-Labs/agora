import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { RTL, t, resolveLang } from "./i18n";
import { ENGINES, engineById, engineByPrefix, engineUrl, type Engine } from "./engines";
import { convertUnits, fmtNum, parseIntLiteral, toBase, CURRENCIES, UNIT_TOKENS, type UnitResult } from "./units";

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
  plan?: string;       // для схемы питания — GUID схемы
  update?: boolean;    // строка-предложение обновиться
  pid?: number;        // для kind "proc" — какой процесс завершать
  host?: string;       // для kind "ssh" — алиас из ssh_config
  ms?: number | null;  // для kind "ssh" — время TCP-коннекта (null = не дошли)
  pstate?: string;     // для kind "ssh" — open | refused | timeout | dns
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
  wxCity: string;
  wxLoc: { lat: number; lon: number; city: string } | null;
  webEngine: string;   // движок по умолчанию для веб-поиска
  sshShell: string;    // в чём открывать сессию: direct | powershell | pwsh | cmd
  sshProfile: string;  // профиль Windows Terminal (пусто — по умолчанию)
  plugins: { calc: boolean; syscmd: boolean; pcmode: boolean; web: boolean; crypto: boolean; weather: boolean; convert: boolean; clipboard: boolean; kill: boolean; ssh: boolean };
}
const DEF: Settings = {
  lang: resolveLang(), hotkey: "Alt+Space", tray: true, theme: "dark", accent: "#0098EA",
  density: "cozy", blur: true, recent: false, autoupdate: true, wxCity: "", wxLoc: null,
  webEngine: "google", sshShell: "direct", sshProfile: "",
  plugins: { calc: true, syscmd: true, pcmode: true, web: true, crypto: true, weather: true, convert: true, clipboard: true, kill: true, ssh: true },
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
  spark:  S('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18 15l.7 1.8L20.5 17l-1.8.7L18 19.5l-.7-1.8L15.5 17l1.8-.7z"/>'),
  calc:   S('<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>'),
  power:  S('<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>'),
  trash:  S('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  moon:   S('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>'),
  lock:   S('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  gear:   S('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  coin:   S('<circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.5-.8-1.5-1.4-2.8-1.4-1.7 0-2.8.9-2.8 2.1 0 2.8 5.8 1.4 5.8 4.2 0 1.2-1.1 2.1-3 2.1-1.4 0-2.5-.6-3-1.5M12 5.8v1.9M12 16.3v1.9"/>'),
  sun:    S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  clip:   S('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  proc:   S('<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>'),
  game:   S('<path d="M6 12h4M8 10v4M15 13h.01M18 11h.01"/><rect x="2" y="6" width="20" height="12" rx="4"/>'),
  work:   S('<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'),
  ssh:    S('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 9.5l2.5 2.5L7 14.5M12.5 15H17"/>'),
};

/* ============================ CATALOG ============================ */
let APPS: Entry[] = [];
let FILES: Entry[] = [];
let CLIPS: string[] = []; // история буфера обмена (обновляется при показе)

// Системные действия. name/sub локализуются; kw — мультиязычные поисковые
// алиасы (латиница + кириллица), чтобы находились на любом языке интерфейса.
interface ActionDef {
  actionId: string;
  icon: keyof typeof I;
  nameKey: Parameters<typeof t>[1];
  subKey: Parameters<typeof t>[1];
  kw: string;
}
const ACTION_DEFS: ActionDef[] = [
  { actionId: "dark_mode", icon: "moon", nameKey: "act_dark", subKey: "act_g_appearance",
    kw: "dark mode light theme тёмная темная светлая тема оформление режим" },
  { actionId: "empty_trash", icon: "trash", nameKey: "act_trash", subKey: "act_g_storage",
    kw: "empty trash recycle bin корзина очистить мусор удалить" },
  { actionId: "sleep", icon: "power", nameKey: "act_sleep", subKey: "act_g_power",
    kw: "sleep suspend сон спящий заснуть питание" },
  { actionId: "lock", icon: "lock", nameKey: "act_lock", subKey: "act_g_power",
    kw: "lock screen блокировка заблокировать замок экран" },
  { actionId: "settings", icon: "gear", nameKey: "act_settings", subKey: "act_g_prefs",
    kw: "settings preferences настройки параметры опции конфигурация" },
  { actionId: "game_mode", icon: "game", nameKey: "act_game", subKey: "act_g_mode",
    kw: "game gaming mode fps performance high perf игровой игра режим производительность" },
  { actionId: "work_mode", icon: "work", nameKey: "act_work", subKey: "act_g_mode",
    kw: "work mode focus productivity balanced quiet рабочий работа режим тихий баланс" },
];
// Активный режим ПК ("game" | "work" | "") — читается из Rust при показе окна
// и обновляется сразу после переключения, чтобы строка показывала состояние.
let PC_MODE = "";

// Схемы питания из системы (те же, что в powercfg.cpl). GAME/WORK Rust не
// отдаёт — они уже представлены действиями «игровой/рабочий режим».
interface PowerPlan { guid: string; name: string; active: boolean }
let PLANS: PowerPlan[] = [];
const PLAN_KW = "power plan scheme powercfg battery energy performance "
  + "схема план питание электропитание питания энергосбережение производительность";

function planEntries(lang: string): Entry[] {
  return PLANS.map(p => ({
    name: p.name,
    sub: t(lang, "act_g_plan") + (p.active ? " · " + t(lang, "mode_on") : ""),
    kind: "action", icon: "power" as const, plan: p.guid,
    keywords: PLAN_KW + " " + p.name,
  }));
}

// Встроенные режимы ПК — отдельный тумблер: кому хватает голых схем питания,
// тот выключает их и не видит в лаунчере.
const MODE_ACTIONS = new Set(["game_mode", "work_mode"]);

function actionEntries(lang: string): Entry[] {
  return ACTION_DEFS
    .filter(d => SET.plugins.pcmode || !MODE_ACTIONS.has(d.actionId))
    .map(d => {
      const on = (d.actionId === "game_mode" && PC_MODE === "game")
              || (d.actionId === "work_mode" && PC_MODE === "work");
      return {
        name: t(lang, d.nameKey),
        sub: t(lang, d.subKey) + (on ? " · " + t(lang, "mode_on") : ""),
        kind: "action", icon: d.icon, actionId: d.actionId, keywords: d.kw,
      };
    });
}

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
  // История буфера — отдельно: её отсутствие не должно ронять каталог.
  if (SET.plugins.clipboard) {
    try { CLIPS = await invoke<string[]>("clipboard_history"); } catch { CLIPS = []; }
  } else CLIPS = [];
  // Активный режим ПК — для индикации в строках game/work.
  if (SET.plugins.syscmd) {
    try { PC_MODE = await invoke<string>("pc_mode"); } catch { PC_MODE = ""; }
    try { PLANS = await invoke<PowerPlan[]>("power_plans"); } catch { PLANS = []; }
  } else PLANS = [];
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
// Умный калькулятор: неявное умножение 2(3), функции sqrt/sin/log…, константы
// pi/π/e/tau, умные проценты 200+15%. Безопасно: собираем выражение из Math.*
// и арифметики, валидируем что чужих букв не осталось, только потом Function.
const CALC_FUNCS = new Set([
  "sqrt", "cbrt", "sin", "cos", "tan", "asin", "acos", "atan",
  "abs", "round", "floor", "ceil", "trunc", "sign", "exp",
  "min", "max", "hypot", "log2",
]);

function prepareExpr(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s || !/\d|pi|π|\be\b/.test(s)) return null;
  // Быстрый отсев: голое слово («figma») не выражение — нужен оператор,
  // скобка с числом, функция или константа.
  if (!/[-+*/^%()]|\b(sqrt|cbrt|sin|cos|tan|log|ln|abs|round|floor|ceil|exp|min|max|hypot|pi|tau)\b|π/.test(s)) return null;

  s = s.replace(/(\d),(?=\d)/g, "$1.");                 // десятичная запятая
  // константы
  s = s.replace(/π/g, "(Math.PI)").replace(/\bpi\b/g, "(Math.PI)")
       .replace(/\btau\b/g, "(2*Math.PI)").replace(/\be\b/g, "(Math.E)");
  // функции (ln = натуральный, log = десятичный)
  s = s.replace(/\bln\b/g, "Math.log").replace(/\blog10\b/g, "Math.log10")
       .replace(/\blog\b/g, "Math.log10");
  s = s.replace(/\b([a-z][a-z0-9]*)\b/g, (m) => (CALC_FUNCS.has(m) ? "Math." + m : m));
  // неявное умножение
  s = s.replace(/\)\s*\(/g, ")*(")                       // )(
       .replace(/([\d.)])\s*\(/g, "$1*(")                // 2( , )(  — но не sqrt(
       .replace(/\)\s*(?=[\d.]|Math)/g, ")*")            // )2 , )Math
       .replace(/([\d.])\s*(?=Math)/g, "$1*");           // 2Math
  s = s.replace(/\^/g, "**");
  // умный процент: A ± B%  ->  A ± A*B/100 (не срабатывает, если за % идёт
  // операнд — включая Math.*, функции уже переписаны к этому моменту)
  s = s.replace(/(\d+(?:\.\d+)?)\s*([+\-])\s*(\d+(?:\.\d+)?)\s*%(?!\s*[\d.(M])/g, "$1$2$1*$3/100");
  // Хвостовой % — доля (50% -> 0.5); % перед операндом — остаток JS (10%3 -> 1),
  // иначе «10%3» превращалось бы в 10/1003 и выдавало уверенно неверный ответ.
  s = s.replace(/%(?!\s*[\d.(M])/g, "/100");

  // Валидация: после вычистки Math.* и чисел/операторов чужих букв быть не должно.
  if (/[a-z]/i.test(s.replace(/Math\.[a-z0-9]+/gi, ""))) return null;
  return s;
}

function tryCalc(query: string): Entry | null {
  const expr = prepareExpr(query);
  if (!expr) return null;
  try {
    const val = Function('"use strict";return (' + expr + ")")();
    if (typeof val === "number" && isFinite(val)) {
      const out = Math.round(val * 1e8) / 1e8;
      return {
        name: query.trim(), sub: "", kind: "answer", icon: "calc", answer: true, eq: true,
        value: out, display: out.toLocaleString("en-US", { maximumFractionDigits: 8 }),
      };
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

// Приватность: не отправляем в CoinGecko слова, которые заведомо не тикеры.
// «10 kg» — единица/валюта (кроме «ton»: Toncoin приоритетнее тонны; голые
// токены вроде «gram» не гейтим — документированный крипто-кейс),
// «kill»/«clip»/«weather» — ключевые слова режимов, ТОЧНОЕ имя установленного
// приложения («steam», «zoom») — поиск, не крипта. Именно точное: сабстринг
// душил бы «sol» (Solitaire) и «one» (OneDrive).
const CRYPTO_OVER_UNIT = new Set(["ton"]);
function cryptoGated(word: string, hasAmount: boolean): boolean {
  if (hasAmount && !CRYPTO_OVER_UNIT.has(word) && (UNIT_TOKENS.has(word) || CURRENCIES.has(word))) return true;
  if (!hasAmount && CURRENCIES.has(word)) return true;
  if (WX_WORDS.has(word) || CLIP_KW.test(word) || KILL_KW.test(word) || SSH_KW.test(word)) return true;
  if (!hasAmount && APPS.some(a => a.name.toLowerCase() === word || a.keywords?.toLowerCase() === word)) return true;
  return false;
}

function tryCrypto(query: string): Entry | null {
  const p0 = parseCrypto(query);
  if (!p0 || !isFinite(p0.amount)) return null;
  const { word, amount, hasAmount } = p0;

  if (cryptoGated(word, hasAmount)) return null;

  if (!symCache.has(word)) {
    // Незнакомое слово — резолвим после паузы ввода, строку пока не показываем.
    if (resolveT) clearTimeout(resolveT);
    resolveT = setTimeout(() => {
      const cur = parseCrypto(q.value);
      // Гейт повторно: к моменту срабатывания таймера каталог приложений
      // мог загрузиться — запланированный до этого запрос не должен утечь.
      if (cur?.word === word && !cryptoGated(word, cur.hasAmount)) resolveSymbol(word);
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

/* ============================ CONVERT ============================ */
// Единицы/температура/системы счисления — чистые функции units.ts (оффлайн).
// Валюты — живой курс через exchangerate-api (без ключа), база USD, кэш 1 ч.
// Грамматика: «100 usd to eur», «10 km in mi», «72f to c», «255 to hex»,
// «0xFF» (одиночный литерал), «unix now», «1700000000 as date».

let fxRates: { t: number; rates: Record<string, number> } | null = null;
let fxBusy = false;

async function fetchRates() {
  fxBusy = true;
  try {
    const j = await (await fetch("https://open.er-api.com/v6/latest/USD")).json();
    if (j?.rates && typeof j.rates === "object") {
      fxRates = { t: Date.now(), rates: j.rates };
      build(q.value); // курс долетел — перерисуем, если запрос всё ещё валютный
    }
  } catch { /* сеть/лимит — оставим «…» или устаревший кэш */ }
  finally { fxBusy = false; }
}

// Разбор числа: апострофы/пробелы — разделители тысяч; запятая — десятичная
// (или тысячная в шаблоне 1,000). Возвращает NaN на мусор.
function parseAmount(raw: string): number {
  let s = raw.replace(/['\s]/g, "");
  if (s.includes(",") && s.includes(".")) {
    // правый разделитель — десятичный
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  }
  return parseFloat(s);
}

// Число (в т.ч. «.5», «-5») + единица (буквы/символы с опц. хвостовой цифрой:
// m2, km2, m3) + связка + единица. Цифра в единице обязательна для площади/объёма;
// число «жадное» по цифрам, поэтому «100 usd» не недобирает до «1»+«00usd».
const CONV_CONN = /^\s*(-?(?:\d[\d.,']*|[.,]\d+))\s*([a-z°"'/]+[0-9]?)\s+(?:to|into|in|as|→|>)\s+([a-z°"'/]+[0-9]?)\s*$/i;

function currencyEntry(amount: number, from: string, to: string): Entry {
  const F = from.toUpperCase(), T = to.toUpperCase();
  const stale = !fxRates || Date.now() - fxRates.t > 3_600_000;
  if (stale && !fxBusy) fetchRates();
  const base: Entry = {
    name: fmtNum(amount) + " " + F, sub: T + " · exchangerate-api",
    kind: "answer", icon: "coin", answer: true, eq: true, value: 0, display: "…",
  };
  if (!fxRates) return base;
  const rf = fxRates.rates[F], rt = fxRates.rates[T];
  if (rf == null || rt == null) return base; // курс есть, кода нет — просто ждём/пусто
  const out = (amount * rt) / rf;
  return { ...base, value: out, display: fmtNum(out) + " " + T, copyText: fmtNum(out) };
}

function catSub(r: UnitResult): string {
  return t(SET.lang, ("conv_" + r.cat) as Parameters<typeof t>[1]);
}

function tryConvert(query: string): Entry | null {
  const m = query.match(CONV_CONN);
  if (!m) return null;
  const amount = parseAmount(m[1]);
  if (!isFinite(amount)) return null;
  const from = m[2].trim().replace(/\s+/g, "").toLowerCase();
  const to = m[3].trim().replace(/\s+/g, "").toLowerCase();

  if (CURRENCIES.has(from) && CURRENCIES.has(to)) return currencyEntry(amount, from, to);

  const r = convertUnits(amount, from, to);
  if (!r) return null;
  return {
    name: fmtNum(amount) + " " + m[2].trim(), sub: catSub(r),
    kind: "answer", icon: "calc", answer: true, eq: true,
    value: r.n, display: fmtNum(r.n) + " " + r.unit, copyText: fmtNum(r.n),
  };
}

// Системы счисления: «255 to hex», «0b1010 to dec», одиночный «0xFF» -> dec.
const BASE_TO = /^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|-?\d+)\s+(?:to|into|in|as)\s+(hex|hexadecimal|bin|binary|oct|octal|dec|decimal)$/i;
const BASE_LONE = /^(0x[0-9a-f]+|0b[01]+|0o[0-7]+)$/i;

function tryBase(query: string): Entry | null {
  const s = query.trim().toLowerCase();
  const mk = (name: string, display: string, sub: string): Entry => ({
    name, sub, kind: "answer", icon: "calc", answer: true, eq: true, value: 0, display, copyText: display,
  });

  const m = s.match(BASE_TO);
  if (m) {
    const v = parseIntLiteral(m[1]);
    if (v == null) return null;
    const tgt = m[2].startsWith("hex") ? "hex" : m[2].startsWith("bin") ? "bin" : m[2].startsWith("oct") ? "oct" : "dec";
    return mk(query.trim(), toBase(v, tgt), t(SET.lang, "conv_base"));
  }
  if (BASE_LONE.test(s)) {
    const v = parseIntLiteral(s);
    if (v == null) return null;
    const sub = "hex " + toBase(v, "hex") + " · oct " + toBase(v, "oct") + " · bin " + toBase(v, "bin");
    return mk(query.trim(), toBase(v, "dec"), sub);
  }
  return null;
}

// Timestamp: «unix now»/«epoch»/«timestamp» -> текущий; «<epoch> as date» -> дата.
const TS_NOW = /^(?:unix|epoch|timestamp)(?:\s+now)?$/i;
const TS_AS_DATE = /^(\d{9,13})\s+(?:as|to|in)\s+(?:date|time|iso|utc)$/i;

function tryTime(query: string): Entry | null {
  const s = query.trim().toLowerCase();
  if (TS_NOW.test(s)) {
    const ms = Date.now();
    const sec = Math.floor(ms / 1000);
    return {
      name: query.trim(), sub: new Date(ms).toISOString(),
      kind: "answer", icon: "calc", answer: true, eq: true,
      value: sec, display: String(sec), copyText: String(sec),
    };
  }
  const m = s.match(TS_AS_DATE);
  if (m) {
    const num = parseInt(m[1], 10);
    const ms = m[1].length >= 12 ? num : num * 1000; // >=12 цифр — миллисекунды
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return {
      name: query.trim(), sub: "UTC " + d.toISOString(),
      kind: "answer", icon: "calc", answer: true, eq: true,
      value: 0, display: d.toLocaleString(), copyText: d.toISOString(),
    };
  }
  return null;
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

/* ============================ WEB SEARCH ============================ */
// Префикс движка: "g: погода", "c: объясни рекурсию", "gpt: …". Пусто -> null.
function matchEnginePrefix(query: string): { engine: Engine; text: string } | null {
  const s = query.trim();
  // «c:\users\…» / «d:/…» — путь Windows (одна буква + \ или / сразу после
  // двоеточия), не префикс движка. «g: /r/rust» и «gpt:/x» — движок.
  if (/^[a-z]:[\\/]/i.test(s)) return null;
  const m = s.match(/^([a-z]+):\s*(.+)$/i);
  if (!m) return null;
  const engine = engineByPrefix(m[1]);
  return engine ? { engine, text: m[2].trim() } : null;
}
function webEntry(e: Engine, text: string): Entry {
  const key = e.ai ? "web_ask" : "web_search";
  return {
    name: t(SET.lang, key).replace("{e}", e.name).replace("{q}", text),
    sub: e.name,
    kind: "search",
    icon: e.ai ? "spark" : "web",
    url: engineUrl(e, text),
  };
}

/* ====================== DIRECT OPEN (url / path) ====================== */
// «github.com» / «https://…» -> открыть в браузере вместо веб-поиска;
// «C:\…» / «\\server\share» -> открыть путь Проводником/ассоциацией.
// Без sh/so/in: коллизия с расширениями файлов (setup.sh, libc.so, Makefile.in)
// перехватывала бы Enter у настоящего файла из «недавних».
const TLD_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|org|net|io|dev|app|ai|me|co|gg|tv|xyz|info|ru|ua|by|kz|de|fr|uk|us|pl|tr|cn|jp|kr|br|es|it|nl|ch|se|fi|no|cz|eu)(:\d+)?([/?#]\S*)?$/i;

function tryUrl(query: string): Entry | null {
  const s = query.trim();
  if (/\s/.test(s)) return null;
  const hasScheme = /^https?:\/\/\S+$/i.test(s);
  if (!hasScheme && !TLD_RE.test(s)) return null;
  return {
    name: s, sub: t(SET.lang, "url_open"), kind: "search", icon: "web",
    url: hasScheme ? s : "https://" + s,
  };
}

function tryPath(query: string): Entry | null {
  const s = query.trim();
  if (!/^([a-z]:[\\/]|\\\\)/i.test(s)) return null;
  return { name: s, sub: t(SET.lang, "path_open"), kind: "file", icon: "folder", path: s };
}

/* ============================ CLIPBOARD ============================ */
// Ключевое слово (clip/clipboard/буфер/история) -> список последних копий из
// памяти Rust; хвост запроса фильтрует по содержимому. Enter кладёт выбранное
// в буфер (дальше Ctrl+V). Пусто -> подсказка.
// «board» убран как слишком общее слово; оставшиеся — явные триггеры буфера.
const CLIP_KW = /^(?:clip|clips|clipboard|буфер|история)(?:\s+([\s\S]*))?$/i;

function matchClip(query: string): string | null {
  const m = query.match(CLIP_KW);
  return m ? (m[1] ?? "").trim() : null;
}

function clipPreview(text: string): string {
  const oneline = text.replace(/\s+/g, " ").trim();
  return oneline.length > 84 ? oneline.slice(0, 84) + "…" : oneline;
}

// Строки истории только если сработало ключевое слово И есть совпадения. Пусто ->
// [] => build() НЕ уходит в эксклюзивный режим, обычный поиск/веб-фолбэк работают.
function clipMode(query: string): Entry[] {
  const filter = matchClip(query);
  if (filter === null) return [];
  const f = filter.toLowerCase();
  const hits = (f ? CLIPS.filter(c => c.toLowerCase().includes(f)) : CLIPS).slice(0, 12);
  return hits.map(c => ({ name: clipPreview(c), sub: "", kind: "clip", icon: "clip", copyText: c }));
}

/* ============================ KILL (processes) ============================ */
// Ключевое слово kill/убить -> список процессов из Rust; хвост фильтрует по имени.
// Enter завершает выбранный (kind "proc"). Список тянется лениво и кэшируется 3с.
interface ProcInfo { pid: number; name: string; mem: number }
const KILL_KW = /^(?:kill|убить|завершить)(?:\s+([\s\S]*))?$/i;
let PROCS: ProcInfo[] = [];
let procsT = 0;
let procsBusy = false;

async function fetchProcs() {
  procsBusy = true;
  try { PROCS = await invoke<ProcInfo[]>("list_processes"); }
  catch { PROCS = []; }
  // procsT ставим и при ошибке — иначе build() в finally тут же зациклит рефетч.
  finally { procsT = Date.now(); procsBusy = false; build(q.value); }
}

const fmtMem = (b: number): string =>
  b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + " GB" : Math.max(1, Math.round(b / (1 << 20))) + " MB";

function killMode(query: string): Entry[] {
  const m = query.match(KILL_KW);
  if (!m) return [];
  const filter = (m[1] ?? "").trim().toLowerCase();
  if (Date.now() - procsT > 3000 && !procsBusy) fetchProcs();
  if (!PROCS.length) {
    // грузим — держим режим строкой-плейсхолдером, чтобы не мигал веб-поиск
    return procsBusy ? [{ name: "…", sub: "", kind: "prochint", icon: "proc" }] : [];
  }
  const list = filter ? PROCS.filter(p => p.name.toLowerCase().includes(filter)) : PROCS;
  return list.slice(0, 14).map(p => ({
    name: p.name, sub: "PID " + p.pid + (p.mem ? " · " + fmtMem(p.mem) : ""),
    kind: "proc", icon: "proc", pid: p.pid,
  }));
}

/* ============================ SSH ============================ */
// Ключевое слово ssh -> хосты из ~/.ssh/config (парсит Rust); хвост фильтрует по
// алиасу/адресу/пользователю. Enter открывает терминал с подключением.
// Доступность — TCP-коннект до порта хоста в Rust, тянется по требованию:
// таймеров нет намеренно, сигнала «панель скрыли» в приложении не существует,
// а интервал без него тикал бы вечно и долбил чужие серверы.
interface SshHost {
  alias: string; hostname: string; user: string;
  port: number; identity: string; forwards: number; managed: boolean;
}
interface SshPing { alias: string; ms: number | null; state: string }
const SSH_KW = /^(?:ssh)(?:\s+([\s\S]*))?$/i;
const SSH_TTL = 15000;   // столько живут и список хостов, и результаты проб
const SSH_SLOW = 150;    // мс, выше которого задержка перестаёт быть «быстрой»
let HOSTS: SshHost[] = [];
let hostsT = 0;
let hostsBusy = false;
const PINGS = new Map<string, SshPing>();
const pingAsked = new Set<string>(); // кого уже спрашивали в текущем окне TTL
let pingT = 0;
let pingBusy = false;

let SSH_CLIENT = true; // есть ли системный OpenSSH — спрашиваем, только если пусто

async function fetchHosts() {
  hostsBusy = true;
  try {
    HOSTS = await invoke<SshHost[]>("ssh_hosts");
    // Пустой список без объяснения выглядит как поломка: отличаем «нет хостов»
    // от «нет клиента». Лишний IPC только в этом случае.
    if (!HOSTS.length) SSH_CLIENT = await invoke<boolean>("ssh_client_present");
  }
  catch { HOSTS = []; }
  // Метку ставим и при ошибке — иначе build() в finally зациклит рефетч.
  finally { hostsT = Date.now(); hostsBusy = false; build(q.value); }
}

async function fetchPings(aliases: string[]) {
  pingBusy = true;
  // Помечаем ДО запроса: хост, на который Rust не ответил (конфиг разъехался),
  // иначе считался бы «неспрошенным» вечно и крутил бы пробу без остановки.
  aliases.forEach(a => pingAsked.add(a));
  try {
    const res = await invoke<SshPing[]>("ssh_probe", { aliases });
    res.forEach(p => PINGS.set(p.alias, p));
  } catch { /* проба не удалась — строки просто останутся без индикатора */ }
  finally { pingT = Date.now(); pingBusy = false; build(q.value); }
}

/** Текст и класс индикатора: пусто, пока проба не вернулась. */
function pingView(o: Entry): { text: string; cls: string } {
  if (o.pstate === "open" && o.ms != null) {
    return { text: o.ms + " ms", cls: o.ms >= SSH_SLOW ? "slow" : "ok" };
  }
  if (o.pstate === "refused") return { text: t(SET.lang, "ssh_refused"), cls: "bad" };
  if (o.pstate === "timeout") return { text: "—", cls: "bad" };
  if (o.pstate === "dns") return { text: "?", cls: "bad" };
  return { text: "", cls: "" };
}

function sshMode(query: string): Entry[] {
  const m = query.match(SSH_KW);
  if (!m) return [];
  const filter = (m[1] ?? "").trim().toLowerCase();
  if (Date.now() - hostsT > SSH_TTL && !hostsBusy) fetchHosts();
  const add: Entry = {
    name: t(SET.lang, "ssh_add"), sub: "", kind: "action", icon: "gear", actionId: "settings",
  };
  if (!HOSTS.length) {
    // Держим режим строкой-плейсхолдером, пока грузим, — чтобы не мигал веб-поиск.
    if (hostsBusy) return [{ name: "…", sub: "", kind: "sshhint", icon: "ssh" }];
    // С хвостом запроса молча уступаем обычному поиску: «ssh» — ещё и начало
    // кучи обычных слов, и режим не должен держать их в заложниках.
    if (filter) return [];
    if (!SSH_CLIENT) return [{ name: t(SET.lang, "ssh_no_client"), sub: "", kind: "sshhint", icon: "ssh" }];
    return [{ name: t(SET.lang, "ssh_no_hosts"), sub: "", kind: "sshhint", icon: "ssh" }, add];
  }
  const list = filter
    ? HOSTS.filter(h => (h.alias + " " + h.hostname + " " + h.user).toLowerCase().includes(filter))
    : HOSTS;
  // Совпадений нет — тоже уступаем: «ssh keygen» должен находить приложение.
  if (filter && !list.length) return [];
  const shown = list.slice(0, 13); // +1 строка «добавить» = те же 14, что у kill

  if (!pingBusy && shown.length) {
    if (Date.now() - pingT > SSH_TTL) pingAsked.clear(); // TTL вышел — пробуем заново
    const need = shown.filter(h => !pingAsked.has(h.alias)).map(h => h.alias);
    if (need.length) fetchPings(need);
  }

  const rows: Entry[] = shown.map(h => {
    const p = PINGS.get(h.alias);
    const target = (h.user ? h.user + "@" : "") + h.hostname + (h.port === 22 ? "" : ":" + h.port);
    const tunnels = h.forwards ? "  ·  " + t(SET.lang, "ssh_tunnel") + " " + h.forwards : "";
    return {
      name: h.alias, sub: target + tunnels, kind: "ssh", icon: "ssh",
      host: h.alias, ms: p?.ms, pstate: p?.state,
    };
  });
  rows.push(add);
  return rows;
}

/* ============================ UPDATE ============================ */
// Обновление в один шаг: фоновая проверка → строка-предложение в лаунчере →
// Enter. Дальше без участия человека: качаем, процесс выходит, NSIS ставит
// тихо (installMode "quiet") и сам поднимает уже новую версию (флаг /R).
let PENDING: Update | null = null;
let UPD: "" | "dl" | "install" = "";
let UPD_PCT = 0;
const UPD_EVERY = 6 * 60 * 60 * 1000; // как часто перепроверять, пока висим в трее

async function checkUpdate() {
  if (!SET.autoupdate || PENDING || UPD) return;
  try {
    const up = await check();
    if (up) { PENDING = up; build(q.value); }
  } catch { /* нет сети или релиза — обновление не срочное, молчим */ }
}

function updateEntry(lang: string): Entry {
  const sub = UPD === "dl" ? t(lang, "upd_dl") + " " + UPD_PCT + "%"
    : UPD === "install" ? t(lang, "upd_installing")
    : t(lang, "upd_row_sub");
  return {
    name: "Nexalix Agora " + (PENDING?.version ?? ""),
    sub, kind: "action", icon: "spark", update: true,
    keywords: "update upgrade version обновить обновление версия апдейт",
  };
}

async function runUpdate() {
  if (!PENDING || UPD) return;
  UPD = "dl"; UPD_PCT = 0; build(q.value);
  let total = 0, got = 0;
  try {
    await PENDING.downloadAndInstall(ev => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        const pct = total ? Math.min(100, Math.round(got * 100 / total)) : 0;
        if (pct !== UPD_PCT) { UPD_PCT = pct; build(q.value); } // перерисовка только на смене процента
      } else if (ev.event === "Finished") { UPD = "install"; build(q.value); }
    });
    // Досюда на Windows не доходим: установщик уже запущен, процесс завершён.
  } catch (e) {
    UPD = ""; build(q.value);
    toast(String(e));
  }
}

/* ============================ RENDER (flat, quiet) ============================ */
// Идентичность строки между перерисовками — чтобы асинхронные rebuild'ы
// (цены/погода/3-сек рефетч процессов) не сбрасывали выделение на верх.
// name в конце обязателен: у 2-3 строк погоды одинаковый copyText (summary),
// без него findIndex схлопывал бы их в одну и выделение прыгало бы на первую.
const entryKey = (o: Entry): string =>
  o.kind + "|" + (o.host ?? o.pid ?? o.path ?? o.url ?? o.plan ?? o.actionId ?? "") + "|" + o.name;
let lastBuiltQuery: string | null = null;

function build(query: string) {
  // Перерисовка того же запроса (долетели данные) — сохраняем активную строку.
  const prevKey = query === lastBuiltQuery && items[active] ? entryKey(items[active].data) : null;
  const prevIdx = active;
  lastBuiltQuery = query;

  const rows: Entry[] = [];
  const calc = SET.plugins.calc ? tryCalc(query) : null;
  if (calc) rows.push(calc);
  const conv = !calc && SET.plugins.convert ? (tryConvert(query) ?? tryBase(query) ?? tryTime(query)) : null;
  if (conv) rows.push(conv);
  const wx = !calc && !conv && SET.plugins.weather ? tryWeather(query) : null;
  if (wx) rows.push(...wx);
  const crypto = !calc && !conv && !wx && SET.plugins.crypto ? tryCrypto(query) : null;
  if (crypto) rows.push(crypto);

  const clip = SET.plugins.clipboard ? clipMode(query) : [];
  const kill = SET.plugins.kill ? killMode(query) : [];
  const ssh = SET.plugins.ssh ? sshMode(query) : [];
  if (!query.trim()) {
    // Пустой запрос — по умолчанию пустая панель, ничего не навязываем.
    // Исключение — готовое обновление: предлагаем, не перебивая ввод.
    if (PENDING) rows.push(updateEntry(SET.lang));
    // Недавние — только если включено в настройках (Show recent on open).
    if (SET.recent) rows.push(...FILES.slice(0, 6));
  } else if (clip.length) {
    // Режим истории буфера — эксклюзивный (только при реальных совпадениях).
    rows.push(...clip);
  } else if (kill.length) {
    // Режим завершения процессов — эксклюзивный.
    rows.push(...kill);
  } else if (ssh.length) {
    // Режим SSH-хостов — эксклюзивный.
    rows.push(...ssh);
  } else {
    // Явный движок по префиксу: "g: …", "c: …", "gpt: …" — главный intent.
    const pe = SET.plugins.web ? matchEnginePrefix(query) : null;
    if (pe) rows.push(webEntry(pe.engine, pe.text));

    // Прямой путь/URL — тоже главный intent: «C:\…» открываем, не ищем в Google.
    const direct = tryPath(query) ?? tryUrl(query);
    if (direct) rows.push(direct);

    const acts = actionEntries(SET.lang);
    const pool: Entry[] = [
      ...APPS,
      ...FILES, // недавние файлы всегда участвуют в поиске
      // Системные действия — при включённом syscmd; настройки доступны всегда.
      ...(SET.plugins.syscmd ? acts : acts.filter(a => a.actionId === "settings")),
      ...(SET.plugins.syscmd ? planEntries(SET.lang) : []),
      ...(PENDING ? [updateEntry(SET.lang)] : []),
    ];
    pool
      .map(o => ({ o, sc: scoreEntry(o, query) }))
      .filter(x => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 14)
      .forEach(x => rows.push(x.o));
    if (!calc && !conv && !wx && !crypto && !pe && SET.plugins.web) {
      rows.push(webEntry(engineById(SET.webEngine), query.trim()));
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
    const sub = o.sub ? '<span class="tail">' + esc(o.sub) + '</span>' : '';
    // Задержка до хоста — собственный слот: .tail видно только на активной
    // строке, а доступность нужна сразу на всех.
    const ping = o.kind === "ssh" ? pingView(o) : null;
    const tail = o.answer
      ? (o.display ? '<span class="answer-val">' + esc(o.display) + '</span>' : '')
      : ping
      ? sub + (ping.text ? '<span class="ping ' + ping.cls + '" dir="ltr">' + esc(ping.text) + '</span>' : '')
      : sub;
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
  if (prevKey !== null && items.length) {
    const same = items.findIndex(it => entryKey(it.data) === prevKey);
    setActive(same >= 0 ? same : Math.min(prevIdx, items.length - 1));
  } else {
    setActive(0);
  }
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
  histIdx = -1; // выход из режима истории: программная очистка не шлёт input
  lastBuiltQuery = null; // скрытие ≠ «данные долетели»: выделение не воскрешаем
  build("");
}

async function run(o: Entry) {
  if (!o) return;
  pushHist(q.value); // запомнить набранный запрос для листания ↑/↓
  if (o.kind === "clip") {
    // Кладём выбранную копию обратно в буфер, прячемся — дальше юзер жмёт Ctrl+V.
    try { await invoke("set_clipboard", { text: o.copyText ?? "" }); } catch { /* нет доступа к буферу */ }
    toast(t(SET.lang, "copied") + "  " + clipPreview(o.copyText ?? ""));
    await hideAndReset();
    return;
  }
  if (o.kind === "prochint" || o.kind === "sshhint") return; // строка-плейсхолдер
  if (o.update) { await runUpdate(); return; } // окно не прячем: видно прогресс
  if (o.plan) {
    try {
      await invoke("set_power_plan", { guid: o.plan });
      PLANS = PLANS.map(p => ({ ...p, active: p.guid === o.plan }));
      // Режим ПК считается по активной схеме — перечитываем, а не гадаем.
      try { PC_MODE = await invoke<string>("pc_mode"); } catch { PC_MODE = ""; }
      build(q.value);
      toast(t(SET.lang, "act_g_plan") + "  " + o.name);
    } catch (e) { toast(String(e)); }
    return;
  }
  if (o.kind === "ssh" && o.host) {
    try { await invoke("ssh_open", { alias: o.host, shell: SET.sshShell, profile: SET.sshProfile }); }
    catch (e) { toast(String(e)); return; } // терминал не поднялся — строка остаётся
    await hideAndReset();
    return;
  }
  if (o.kind === "proc" && o.pid != null) {
    try {
      await invoke("kill_process", { pid: o.pid });
      toast(t(SET.lang, "killed") + "  " + o.name);
      PROCS = PROCS.filter(p => p.pid !== o.pid); // сразу убрать строку — без гонки/двойного kill
      build(q.value);
    } catch (e) { toast(String(e)); return; } // ошибка (напр. критический) — строка остаётся
    procsT = 0;   // форсим рефетч для сверки со снапшотом
    fetchProcs();
    return;
  }
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
      if (o.actionId === "game_mode" || o.actionId === "work_mode") {
        // Режим переключён — сразу отражаем это в списке, не дожидаясь refreshCatalog.
        PC_MODE = o.actionId === "game_mode" ? "game" : "work";
        build(q.value);
      }
      if (o.actionId === "dark_mode" || o.actionId === "empty_trash"
          || o.actionId === "game_mode" || o.actionId === "work_mode") {
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

/* ============================ HISTORY ============================ */
// История запросов в localStorage (последние 50, новые в конце). Листается
// стрелкой ↑ при пустом вводе с верхней строки (или пустой панели) — навигацию
// по результатам не ломает, а при включённых «недавних» остаётся достижимой.
// Любой ввод символа выходит из режима истории.
const HIST_KEY = "agora.hist";
const HIST_MAX = 50;
let histIdx = -1;   // -1 = не листаем; иначе индекс в массиве истории
let histDraft = ""; // черновик до входа в историю

function loadHist(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}
function pushHist(text: string) {
  const s = text.trim();
  if (!s) return;
  let h = loadHist().filter(x => x !== s); // дедуп: убираем прошлое вхождение
  h.push(s);
  if (h.length > HIST_MAX) h = h.slice(h.length - HIST_MAX);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch { /* приватный режим */ }
}

/* ============================ EVENTS ============================ */
q.addEventListener("input", () => { histIdx = -1; build(q.value); });
q.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (histIdx >= 0) {
      const h = loadHist();
      histIdx++;
      if (histIdx >= h.length) { histIdx = -1; q.value = histDraft; } else q.value = h[histIdx];
      build(q.value);
    } else setActive(active + 1);
  }
  else if (e.key === "ArrowUp") {
    e.preventDefault();
    const canHist = histIdx >= 0 || (q.value === "" && (items.length === 0 || active === 0));
    const h = canHist ? loadHist() : [];
    if (canHist && h.length) {
      if (histIdx < 0) { histDraft = q.value; histIdx = h.length; }
      if (histIdx > 0) { histIdx = Math.min(histIdx, h.length) - 1; q.value = h[histIdx]; build(q.value); }
    } else setActive(active - 1);
  }
  else if (e.key === "Enter") { e.preventDefault(); if (items[active]) run(items[active].data); }
  else if (e.key === "Escape") {
    e.preventDefault();
    histIdx = -1; // сброс режима истории
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
  histIdx = -1; // новый вызов лаунчера — история с начала
  lastBuiltQuery = null; // свежее открытие всегда стартует с верхней строки
  hostsT = 0; // конфиг могли поправить снаружи — перечитываем при показе
  pingT = 0;  // и доступность меряем заново, а не показываем прошлогоднюю
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
if (!demo.has("demo") && !demoQ) {
  refreshCatalog();
  // Не на старте: сеть при логине занята, а обновление подождёт.
  setTimeout(checkUpdate, 15_000);
  setInterval(checkUpdate, UPD_EVERY);
}
