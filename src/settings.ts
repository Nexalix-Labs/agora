import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { LANGS, RTL, t, resolveLang, type Key } from "./i18n";

/* ============ STATE ============ */
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
  binds: Bind[];
  plugins: { calc: boolean; syscmd: boolean; web: boolean; files: boolean; crypto: boolean; weather: boolean };
}
interface Bind {
  name: string;
  hotkey: string;
  kind: "app" | "cmd";
  target: string;   // shell:AppsFolder\... или путь/URL/команда
  label?: string;
}
const DEF: Settings = {
  lang: resolveLang(), hotkey: "Alt+Space", tray: true, theme: "dark", accent: "#0098EA",
  density: "cozy", blur: true, recent: false, autoupdate: true, channel: "stable", wxCity: "",
  binds: [],
  plugins: { calc: true, syscmd: true, web: true, files: true, crypto: true, weather: true },
};
let S: Settings = { ...DEF, plugins: { ...DEF.plugins } };

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const $$ = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const win = $("#window");
// null вне Tauri (рендер страницы в браузере) — кнопки окна просто неактивны.
const appWin = (() => { try { return getCurrentWindow(); } catch { return null; } })();

const T = (k: Key) => t(S.lang, k);

// Сохраняем через Rust: файл + пере-регистрация хоткея + событие всем окнам.
async function save(): Promise<void> {
  await invoke("set_settings", { value: S });
}
function saveQuiet() { save().catch(e => toast(String(e))); }

/* ============ TOAST ============ */
let toastT: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string) {
  let el = document.querySelector<HTMLDivElement>("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  requestAnimationFrame(() => el!.classList.add("on"));
  if (toastT) clearTimeout(toastT);
  toastT = setTimeout(() => el!.classList.remove("on"), 2200);
}

/* ============ TITLEBAR (Windows) ============ */
$("#btnClose").addEventListener("click", () => { appWin?.hide().catch(() => {}); });
$("#btnMin").addEventListener("click", () => { appWin?.minimize().catch(() => {}); });

/* ============ NAV ============ */
$$(".navitem").forEach(it => it.addEventListener("click", () => {
  const p = it.dataset.pane;
  $$(".navitem").forEach(n => n.classList.toggle("active", n === it));
  $$(".pane").forEach(pane => pane.classList.toggle("active", pane.dataset.pane === p));
  $("#content").scrollTop = 0;
}));

/* ============ I18N ============ */
function applyI18n() {
  document.documentElement.dir = RTL.has(S.lang) ? "rtl" : "ltr";
  $$("[data-i18n]").forEach(el => {
    el.textContent = t(S.lang, el.dataset.i18n as Key);
  });
  $$("[data-i18n-ph]").forEach(el => {
    (el as HTMLInputElement).placeholder = t(S.lang, el.dataset.i18nPh as Key);
  });
  $("#upds").textContent = "Agora " + version + " · " + T("checked_now");
  $("#aboutVer").textContent = T("ver_word") + " " + version + " · Windows";
  renderPlugins();
  renderBinds();
}

/* ============ THEME / ACCENT (live, в самом окне настроек) ============ */
const systemLight = window.matchMedia("(prefers-color-scheme: light)");
function applyTheme() {
  let th: string = S.theme;
  if (th === "system") th = systemLight.matches ? "light" : "dark";
  win.classList.toggle("light", th === "light");
}
systemLight.addEventListener("change", () => { if (S.theme === "system") applyTheme(); });

function applyAccent() {
  document.documentElement.style.setProperty("--accent", S.accent);
  document.documentElement.style.setProperty("--accent-hi", S.accent);
}

/* ============ CONTROLS ============ */
function syncControls() {
  $$(".switch[data-key]").forEach(sw => {
    const key = sw.dataset.key as "tray" | "blur" | "recent" | "autoupdate";
    sw.classList.toggle("on", !!S[key]);
  });
  $$("[data-seg]").forEach(seg => {
    const grp = seg.dataset.seg as "channel" | "theme" | "density";
    const val = S[grp];
    seg.querySelectorAll<HTMLElement>(".seg").forEach(s => s.classList.toggle("active", s.dataset.val === val));
  });
  $$("[data-swatches] .sw").forEach(sw =>
    sw.classList.toggle("sel", (sw.dataset.c ?? "").toLowerCase() === S.accent.toLowerCase()));
  renderHk($("#hkSummon"), S.hotkey);
  ($("#wxCity") as HTMLInputElement).value = S.wxCity;
  syncLangDD();
  applyTheme();
  applyAccent();
}

$("#wxCity").addEventListener("change", () => {
  S.wxCity = ($("#wxCity") as HTMLInputElement).value.trim();
  saveQuiet();
});

$$(".switch[data-key]").forEach(sw => {
  const key = sw.dataset.key as "tray" | "blur" | "recent" | "autoupdate";
  sw.addEventListener("click", () => {
    S[key] = !S[key];
    sw.classList.toggle("on", S[key]);
    saveQuiet();
  });
});

$$("[data-seg]").forEach(seg => {
  const grp = seg.dataset.seg as "channel" | "theme" | "density";
  seg.querySelectorAll<HTMLElement>(".seg").forEach(s => s.addEventListener("click", () => {
    const val = s.dataset.val ?? "";
    if (grp === "theme") S.theme = val as Settings["theme"];
    else if (grp === "density") S.density = val as Settings["density"];
    else S.channel = val;
    seg.querySelectorAll<HTMLElement>(".seg").forEach(x => x.classList.toggle("active", x === s));
    if (grp === "theme") applyTheme();
    saveQuiet();
  }));
});

$$("[data-swatches] .sw").forEach(sw => {
  sw.addEventListener("click", () => {
    S.accent = sw.dataset.c ?? DEF.accent;
    $$("[data-swatches] .sw").forEach(x => x.classList.toggle("sel", x === sw));
    applyAccent();
    saveQuiet();
  });
});

/* ============ LANGUAGE (кастомный дропдаун) ============ */
const langDD = $("#langDD");
const ddBtn = $("#ddBtn");
const ddLabel = $("#ddLabel");
const ddMenu = $("#ddMenu");
const TICK = '<svg class="tick" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>';

LANGS.forEach(([code, native]) => {
  const it = document.createElement("div");
  it.className = "dd-item";
  it.dataset.val = code;
  it.setAttribute("role", "option");
  it.innerHTML = "<span>" + native + "</span>" + TICK;
  it.addEventListener("click", () => {
    S.lang = code;
    closeDD();
    syncLangDD();
    applyI18n();
    saveQuiet();
  });
  ddMenu.appendChild(it);
});

function syncLangDD() {
  const native = LANGS.find(([c]) => c === S.lang)?.[1] ?? S.lang;
  ddLabel.textContent = native;
  ddMenu.querySelectorAll<HTMLElement>(".dd-item").forEach(it =>
    it.classList.toggle("sel", it.dataset.val === S.lang));
}

function openDD() {
  langDD.classList.add("open");
  // position:fixed — не клипается скролл-контейнером; флип вверх, если снизу тесно
  const r = ddBtn.getBoundingClientRect();
  const h = Math.min(300, ddMenu.scrollHeight);
  const below = window.innerHeight - r.bottom - 10;
  ddMenu.style.top = (below >= h ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + "px";
  const w = Math.max(220, r.width);
  ddMenu.style.left = Math.max(8, r.right - w) + "px";
  ddMenu.style.minWidth = w + "px";
  ddMenu.querySelector<HTMLElement>(".dd-item.sel")?.scrollIntoView({ block: "nearest" });
}
function closeDD() { langDD.classList.remove("open"); }

ddBtn.addEventListener("click", e => {
  e.stopPropagation();
  langDD.classList.contains("open") ? closeDD() : openDD();
});
document.addEventListener("click", e => {
  if (langDD.classList.contains("open") && !(e.target as HTMLElement).closest("#langDD")) closeDD();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDD(); });
$("#content").addEventListener("scroll", closeDD);

/* ============ AUTOSTART (плагин, вне settings.json) ============ */
const swAuto = $("#swAutostart");
invoke<boolean>("plugin:autostart|is_enabled")
  .then(on => swAuto.classList.toggle("on", on))
  .catch(() => {});
swAuto.addEventListener("click", async () => {
  const on = !swAuto.classList.contains("on");
  try {
    await invoke(on ? "plugin:autostart|enable" : "plugin:autostart|disable");
    swAuto.classList.toggle("on", on);
  } catch (e) {
    toast(String(e));
  }
});

/* ============ HOTKEY RECORDER (общий: summon + свои бинды) ============ */
function renderHk(el: HTMLElement, combo: string) {
  el.innerHTML = combo.split("+").map(k => '<span class="kbd">' + k + '</span>').join("");
}
let recEl: HTMLElement | null = null;
let recDone: ((combo: string | null) => void) | null = null;

function startRec(el: HTMLElement, done: (combo: string | null) => void) {
  if (recEl) cancelRec();
  recEl = el;
  recDone = done;
  el.classList.add("recording");
  el.innerHTML = '<span class="rec">' + T("recording") + '</span>';
}
function cancelRec() {
  const el = recEl, d = recDone;
  recEl = null; recDone = null;
  el?.classList.remove("recording");
  d?.(null);
}
// e.key -> имя клавиши в формате global-shortcut ("Alt+Space", "Ctrl+Shift+K").
function keyName(k: string): string | null {
  if (k === " ") return "Space";
  if (k.length === 1) return k.toUpperCase();
  if (/^F\d{1,2}$/.test(k)) return k;
  const map: Record<string, string> = {
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Enter: "Enter", Tab: "Tab", Home: "Home", End: "End",
    PageUp: "PageUp", PageDown: "PageDown", Backspace: "Backspace", Delete: "Delete",
  };
  return map[k] ?? null;
}
document.addEventListener("keydown", e => {
  if (!recEl) return;
  e.preventDefault();
  if (e.key === "Escape") { cancelRec(); return; }
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
    recEl.innerHTML = mods.map(m => '<span class="kbd">' + m + '</span>').join("") + '<span class="rec">…</span>';
    return;
  }
  const k = keyName(e.key);
  if (!k || !mods.length) return; // глобальный хоткей без модификатора не даём
  const el = recEl, d = recDone;
  recEl = null; recDone = null;
  el.classList.remove("recording");
  d?.([...mods, k].join("+"));
});
document.addEventListener("click", e => {
  if (recEl && !(e.target as HTMLElement).closest(".hk")) cancelRec();
});

const hkEl = $("#hkSummon");
hkEl.addEventListener("click", () => {
  if (recEl === hkEl) return;
  startRec(hkEl, combo => {
    if (!combo) { renderHk(hkEl, S.hotkey); return; }
    const prev = S.hotkey;
    S.hotkey = combo;
    renderHk(hkEl, combo);
    save().catch(err => {
      // Rust не смог распарсить/зарегистрировать — откатываемся.
      S.hotkey = prev;
      renderHk(hkEl, prev);
      saveQuiet();
      toast(String(err));
    });
  });
});

/* ============ CUSTOM BINDS ============ */
const bindEditor = $("#bindEditor");
const bindHk = $("#bindHk");
const bindName = $("#bindName") as HTMLInputElement;
const bindTarget = $("#bindTarget") as HTMLInputElement;
const bindAppList = $("#bindAppList");
let editorCombo: string | null = null;
let editorKind: "app" | "cmd" = "app";
let editorApp: { name: string; path: string } | null = null;
interface AppEntry { name: string; path: string; keywords?: string }
let appsCache: AppEntry[] | null = null;

async function loadApps(): Promise<AppEntry[]> {
  if (!appsCache) {
    try { appsCache = await invoke<AppEntry[]>("index_apps"); } catch { appsCache = []; }
  }
  return appsCache;
}

function bindLabel(b: Bind): string {
  return b.label ?? b.target;
}

function renderBinds() {
  const list = $("#bindList");
  list.innerHTML = "";
  if (!S.binds.length) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = '<div class="txt"><div class="ds">' + T("bind_empty") + '</div></div>';
    list.appendChild(row);
    return;
  }
  S.binds.forEach((b, i) => {
    const row = document.createElement("div");
    row.className = "row";
    const kbds = b.hotkey.split("+").map(k => '<span class="kbd">' + k + '</span>').join("");
    row.innerHTML =
      '<div class="txt"><div class="nm"></div><div class="ds"></div></div>' +
      '<div class="ctl" style="display:flex; align-items:center; gap:10px;">' +
      '<div class="hk static">' + kbds + '</div>' +
      '<button class="btn" data-del="' + i + '" title="Delete">✕</button></div>';
    row.querySelector<HTMLElement>(".nm")!.textContent = b.name;
    row.querySelector<HTMLElement>(".ds")!.textContent = bindLabel(b);
    list.appendChild(row);
  });
  list.querySelectorAll<HTMLElement>("[data-del]").forEach(btn => btn.addEventListener("click", () => {
    const i = +btn.dataset.del!;
    const removed = S.binds.splice(i, 1);
    save().then(renderBinds).catch(err => {
      S.binds.splice(i, 0, ...removed);
      renderBinds();
      toast(String(err));
    });
  }));
}

function resetEditor() {
  editorCombo = null;
  editorKind = "app";
  editorApp = null;
  bindName.value = "";
  bindTarget.value = "";
  bindHk.innerHTML = '<span class="kbd">—</span>';
  bindAppList.classList.remove("on");
  $("#bindKind").querySelectorAll<HTMLElement>(".seg").forEach(s =>
    s.classList.toggle("active", s.dataset.val === "app"));
  bindTarget.placeholder = T("bind_search_ph");
}

$("#bindAdd").addEventListener("click", () => {
  resetEditor();
  bindEditor.style.display = "";
  loadApps();
  bindName.focus();
});
$("#bindCancel").addEventListener("click", () => { bindEditor.style.display = "none"; });

bindHk.addEventListener("click", () => {
  if (recEl === bindHk) return;
  startRec(bindHk, combo => {
    if (combo) editorCombo = combo;
    if (editorCombo) renderHk(bindHk, editorCombo);
    else bindHk.innerHTML = '<span class="kbd">—</span>';
  });
});

$("#bindKind").querySelectorAll<HTMLElement>(".seg").forEach(s => s.addEventListener("click", () => {
  editorKind = (s.dataset.val as "app" | "cmd") ?? "app";
  $("#bindKind").querySelectorAll<HTMLElement>(".seg").forEach(x => x.classList.toggle("active", x === s));
  editorApp = null;
  bindTarget.value = "";
  bindAppList.classList.remove("on");
  bindTarget.placeholder = T(editorKind === "app" ? "bind_search_ph" : "bind_cmd_ph");
}));

bindTarget.addEventListener("input", async () => {
  if (editorKind !== "app") return;
  editorApp = null;
  const qs = bindTarget.value.trim().toLowerCase();
  if (!qs) { bindAppList.classList.remove("on"); return; }
  const apps = await loadApps();
  const hits = apps
    .filter(a => a.name.toLowerCase().includes(qs) || (a.keywords ?? "").toLowerCase().includes(qs))
    .slice(0, 8);
  bindAppList.innerHTML = "";
  hits.forEach(a => {
    const it = document.createElement("div");
    it.className = "ai";
    it.innerHTML = '<span class="ph"></span><span></span>';
    it.querySelector<HTMLElement>("span:last-child")!.textContent = a.name;
    invoke<string | null>("app_icon", { path: a.path }).then(uri => {
      if (!uri) return;
      const img = document.createElement("img");
      img.src = uri;
      it.querySelector(".ph")?.replaceWith(img);
    }).catch(() => {});
    it.addEventListener("click", () => {
      editorApp = { name: a.name, path: a.path };
      bindTarget.value = a.name;
      if (!bindName.value.trim()) bindName.value = a.name;
      bindAppList.classList.remove("on");
    });
    bindAppList.appendChild(it);
  });
  bindAppList.classList.toggle("on", hits.length > 0);
});
document.addEventListener("click", e => {
  if (!(e.target as HTMLElement).closest("#bindAppList") && e.target !== bindTarget) {
    bindAppList.classList.remove("on");
  }
});

$("#bindSave").addEventListener("click", () => {
  const name = bindName.value.trim();
  const target = editorKind === "app" ? editorApp?.path : bindTarget.value.trim();
  if (!editorCombo || !name || !target) { toast(T("bind_press")); return; }
  const bind: Bind = {
    name,
    hotkey: editorCombo,
    kind: editorKind,
    target,
    label: editorKind === "app" ? editorApp!.name : target,
  };
  S.binds.push(bind);
  save().then(() => {
    bindEditor.style.display = "none";
    renderBinds();
  }).catch(err => {
    S.binds.pop();
    toast(String(err));
  });
});

/* ============ UPDATES (настоящие: GitHub Releases + подпись) ============ */
let version = "—";
let pendingUpdate: Update | null = null;
$("#checkBtn").addEventListener("click", async () => {
  const btn = $("#checkBtn") as HTMLButtonElement, txt = $("#upds");
  btn.disabled = true;
  try {
    if (pendingUpdate) {
      btn.textContent = T("upd_installing");
      await pendingUpdate.downloadAndInstall();
      await relaunch();
      return;
    }
    btn.textContent = T("checking");
    txt.textContent = T("contacting");
    const up = await check();
    if (up) {
      pendingUpdate = up;
      txt.textContent = T("upd_available") + ": Agora " + up.version;
      btn.textContent = T("upd_install");
    } else {
      txt.textContent = "Agora " + version + " · " + T("uptodate_l") + " · " + T("checked_now");
      btn.textContent = T("checknow");
    }
  } catch (e) {
    txt.textContent = String(e);
    btn.textContent = T("checknow");
    pendingUpdate = null;
  } finally {
    btn.disabled = false;
  }
});

/* ============ PLUGINS ============ */
type PluginId = keyof Settings["plugins"];
const PLUGINS: { id: PluginId | null; nm: Key; ds: Key; raw: string }[] = [
  { id: null, nm: "p_apps_nm", ds: "p_apps_ds",
    raw: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>' },
  { id: "calc", nm: "p_calc_nm", ds: "p_calc_ds",
    raw: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>' },
  { id: "files", nm: "p_files_nm", ds: "p_files_ds",
    raw: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>' },
  { id: "syscmd", nm: "p_sys_nm", ds: "p_sys_ds",
    raw: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>' },
  { id: "crypto", nm: "p_crypto_nm", ds: "p_crypto_ds",
    raw: '<circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.5-.8-1.5-1.4-2.8-1.4-1.7 0-2.8.9-2.8 2.1 0 2.8 5.8 1.4 5.8 4.2 0 1.2-1.1 2.1-3 2.1-1.4 0-2.5-.6-3-1.5M12 5.8v1.9M12 16.3v1.9"/>' },
  { id: "weather", nm: "p_wx_nm", ds: "p_wx_ds",
    raw: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' },
  { id: "web", nm: "p_web_nm", ds: "p_web_ds",
    raw: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>' },
];
function renderPlugins() {
  const pl = $("#pluginList");
  pl.innerHTML = "";
  PLUGINS.forEach(p => {
    const row = document.createElement("div");
    row.className = "row";
    const ctl = p.id
      ? '<div class="switch' + (S.plugins[p.id] ? " on" : "") + '" data-pl="' + p.id + '"></div>'
      : '<span class="pill core">core</span>';
    row.innerHTML =
      '<span class="pico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + p.raw + '</svg></span>' +
      '<div class="txt"><div class="nm">' + T(p.nm) + '</div><div class="ds">' + T(p.ds) + '</div></div>' +
      '<div class="ctl">' + ctl + '</div>';
    pl.appendChild(row);
  });
  $$("[data-pl]").forEach(sw => sw.addEventListener("click", () => {
    const id = sw.dataset.pl as PluginId;
    S.plugins[id] = !S.plugins[id];
    sw.classList.toggle("on", S.plugins[id]);
    saveQuiet();
  }));
}

/* ============ INIT ============ */
(async () => {
  try {
    const v = await invoke<unknown>("get_settings");
    if (v && typeof v === "object") {
      const p = v as Partial<Settings>;
      S = { ...DEF, ...p, plugins: { ...DEF.plugins, ...(p.plugins ?? {}) } };
      if (!S.lang) S.lang = resolveLang();
      if (!Array.isArray(S.binds)) S.binds = [];
    }
  } catch { /* дефолты */ }
  try {
    version = await getVersion();
  } catch { /* не критично */ }
  $("#sideVer").textContent = "v" + version;
  syncControls();
  applyI18n();
})();
