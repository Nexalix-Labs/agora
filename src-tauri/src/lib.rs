use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Clone)]
struct Entry {
    name: String,
    sub: String,
    path: String,
    /// Скрытая строка для поиска (латинский AppID/AUMID) — чтобы локализованное
    /// имя «Терминал» находилось по латинскому «terminal» через WindowsTerminal.
    #[serde(default)]
    keywords: String,
}

/// RAII-обёртка COM: инициализирует апартмент на текущем потоке и корректно
/// разбалансирует только если мы его подняли (RPC_E_CHANGED_MODE не трогаем).
#[cfg(windows)]
struct ComGuard(bool);

#[cfg(windows)]
impl ComGuard {
    fn new() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        // S_OK и S_FALSE (уже инициализирован на потоке) требуют парного uninit;
        // RPC_E_CHANGED_MODE (поток уже MTA) — нет.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        ComGuard(hr.is_ok())
    }
}

#[cfg(windows)]
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            use windows::Win32::System::Com::CoUninitialize;
            unsafe { CoUninitialize() };
        }
    }
}

/// Каталог приложений = виртуальная папка `shell:AppsFolder`. В неё входят и
/// классические Win32-программы, и пакетные UWP/Store-приложения (Terminal,
/// Calculator и т.п.) — тот же источник, что у поиска Windows. Каждый элемент
/// запускается как `shell:AppsFolder\<parsing-id>`.
#[cfg(windows)]
#[tauri::command]
fn index_apps() -> Vec<Entry> {
    match enum_apps_folder() {
        Ok(mut v) => {
            v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            v
        }
        Err(_) => Vec::new(),
    }
}

#[cfg(windows)]
fn enum_apps_folder() -> windows::core::Result<Vec<Entry>> {
    use std::ffi::c_void;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, IEnumShellItems, IShellItem, SHCreateItemFromParsingName,
        SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
    };

    let _com = ComGuard::new();
    let mut out: Vec<Entry> = Vec::new();

    unsafe {
        let root = HSTRING::from("shell:AppsFolder");
        let apps: IShellItem = SHCreateItemFromParsingName(PCWSTR(root.as_ptr()), None)?;
        let items: IEnumShellItems = apps.BindToHandler(None, &BHID_EnumItems)?;

        loop {
            let mut buf: [Option<IShellItem>; 1] = [None];
            let mut fetched: u32 = 0;
            let hr = items.Next(&mut buf, Some(&mut fetched));
            if hr.is_err() || fetched == 0 {
                break;
            }
            let Some(item) = buf[0].take() else { break };

            let name = match item.GetDisplayName(SIGDN_NORMALDISPLAY) {
                Ok(p) => {
                    let s = p.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(p.0 as *const c_void));
                    s
                }
                Err(_) => continue,
            };
            let id = match item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING) {
                Ok(p) => {
                    let s = p.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(p.0 as *const c_void));
                    s
                }
                Err(_) => continue,
            };
            if name.is_empty() || id.is_empty() {
                continue;
            }
            out.push(Entry {
                name,
                sub: "Applications".into(),
                path: format!("shell:AppsFolder\\{id}"),
                keywords: id,
            });
        }
    }
    Ok(out)
}

#[cfg(not(windows))]
#[tauri::command]
fn index_apps() -> Vec<Entry> {
    Vec::new()
}

/// Недавние файлы из %APPDATA%\Microsoft\Windows\Recent (свежие сверху).
#[tauri::command]
fn recent_files() -> Vec<Entry> {
    let Ok(a) = std::env::var("APPDATA") else {
        return Vec::new();
    };
    let dir = PathBuf::from(a).join(r"Microsoft\Windows\Recent");
    let mut v: Vec<(std::time::SystemTime, Entry)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            let is_lnk = p
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("lnk"));
            if !is_lnk {
                continue;
            }
            let Some(name) = p.file_stem().and_then(|x| x.to_str()).map(String::from) else {
                continue;
            };
            // Отсеиваем shell-команды (ms-actioncenter…, содержат & / =) — это не файлы.
            let low = name.to_ascii_lowercase();
            if low.starts_with("ms-") || name.contains('&') || name.contains('=') {
                continue;
            }
            let t = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            v.push((
                t,
                Entry {
                    name,
                    sub: "Recent".into(),
                    path: p.to_string_lossy().into_owned(),
                    keywords: String::new(),
                },
            ));
        }
    }
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().take(6).map(|(_, e)| e).collect()
}

/// ShellExecuteW "open" — запускает ярлык/файл/URL так же, как двойной клик.
#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let op = HSTRING::from("open");
    let file = HSTRING::from(target);
    let h = unsafe {
        ShellExecuteW(
            None,
            &op,
            &file,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if h.0 as usize > 32 {
        Ok(())
    } else {
        Err(format!("Не удалось открыть: {target}"))
    }
}

/// ShellExecuteW с явным lpParameters (для запуска через explorer.exe).
#[cfg(windows)]
fn shell_open_params(file: &str, params: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let op = HSTRING::from("open");
    let file = HSTRING::from(file);
    let par = HSTRING::from(params);
    let h = unsafe {
        ShellExecuteW(
            None,
            &op,
            &file,
            PCWSTR(par.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if h.0 as usize > 32 {
        Ok(())
    } else {
        Err(format!("Не удалось запустить: {params}"))
    }
}

#[cfg(not(windows))]
fn shell_open(_target: &str) -> Result<(), String> {
    Err("only windows".into())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    // UWP/AppsFolder-элементы запускаются только через shell-неймспейс —
    // отдаём explorer.exe как «открывашке».
    #[cfg(windows)]
    if path.starts_with("shell:") {
        return shell_open_params("explorer.exe", &path);
    }
    shell_open(&path)
}

/* ============================ APP ICONS ============================ */

/// Кэш иконок на всю сессию: path -> Some(data-uri) | None(«достали, иконки нет»).
/// Иначе SHGetFileInfo дёргался бы на каждое нажатие клавиши.
#[derive(Default)]
struct IconCache(Mutex<HashMap<String, Option<String>>>);

/// Реальная иконка файла/ярлыка как PNG data-URI. Ленивая выдача по видимым
/// строкам + кэш; фронт подменяет ею SVG-заглушку.
#[tauri::command]
fn app_icon(state: State<'_, IconCache>, path: String) -> Option<String> {
    if let Ok(cache) = state.0.lock() {
        if let Some(hit) = cache.get(&path) {
            return hit.clone();
        }
    }
    let icon = extract_icon_datauri(&path);
    if let Ok(mut cache) = state.0.lock() {
        cache.insert(path, icon.clone());
    }
    icon
}

/// Иконка/плитка элемента (файл или `shell:AppsFolder\…`) через шелловую
/// фабрику изображений — умеет и Win32-иконки, и UWP-тайлы.
#[cfg(windows)]
fn extract_icon_datauri(path: &str) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use windows::core::{Interface, HSTRING, PCWSTR};
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    use windows::Win32::UI::Shell::{
        IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
        SIIGBF_ICONONLY,
    };

    let _com = ComGuard::new();
    let wide = HSTRING::from(path);
    let (w, h, buf) = unsafe {
        let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()?;
        let factory: IShellItemImageFactory = item.cast().ok()?;
        let size = SIZE { cx: 48, cy: 48 };
        let hbmp = factory
            .GetImage(size, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK)
            .ok()?;
        let rgba = hbitmap_to_rgba(hbmp);
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        rgba?
    };
    let png = encode_png(w, h, &buf)?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

/// HBITMAP (32bpp premultiplied BGRA от шелла) -> (w, h, straight RGBA top-down).
/// Всегда освобождает временный DC.
#[cfg(windows)]
unsafe fn hbitmap_to_rgba(
    hbm: windows::Win32::Graphics::Gdi::HBITMAP,
) -> Option<(u32, u32, Vec<u8>)> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
        DIB_RGB_COLORS, HDC, HGDIOBJ,
    };

    if hbm.is_invalid() {
        return None;
    }
    let mut bm = BITMAP::default();
    let got = GetObjectW(
        HGDIOBJ(hbm.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut _ as *mut c_void),
    );
    if got == 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    if w <= 0 || h <= 0 || w > 512 || h > 512 {
        return None;
    }

    let hdc: HDC = GetDC(None);
    if hdc.is_invalid() {
        return None;
    }
    let mut bi = BITMAPINFO::default();
    bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h; // отрицательная = top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = 0; // BI_RGB

    let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
    let lines = GetDIBits(
        hdc,
        hbm,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut c_void),
        &mut bi,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    if lines == 0 {
        return None;
    }

    // Premultiplied BGRA -> straight RGBA.
    let mut any_alpha = false;
    for px in buf.chunks_exact_mut(4) {
        let (b, g, r, a) = (px[0], px[1], px[2], px[3]);
        if a != 0 {
            any_alpha = true;
        }
        if a != 0 && a != 255 {
            let av = u32::from(a);
            let un = |c: u8| ((u32::from(c) * 255 + av / 2) / av).min(255) as u8;
            px[0] = un(r);
            px[1] = un(g);
            px[2] = un(b);
            px[3] = a;
        } else {
            px[0] = r; // swap B<->R
            px[2] = b;
        }
    }
    // Иконка без альфа-канала (все 0) — делаем непрозрачной.
    if !any_alpha {
        for px in buf.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }
    Some((w as u32, h as u32, buf))
}

#[cfg(windows)]
fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(out)
}

#[cfg(not(windows))]
fn extract_icon_datauri(_path: &str) -> Option<String> {
    None
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("bad url".into());
    }
    shell_open(&url)
}

/// Системные действия. Возвращают текст для тоста.
#[tauri::command]
fn run_action(app: AppHandle, id: String) -> Result<String, String> {
    if id == "settings" {
        show_settings(&app);
        return Ok("Settings".into());
    }
    #[cfg(windows)]
    match id.as_str() {
        "lock" => {
            use windows::Win32::System::Shutdown::LockWorkStation;
            unsafe { LockWorkStation() }.map_err(|e| e.to_string())?;
            Ok("Locked".into())
        }
        "sleep" => {
            use windows::Win32::System::Power::SetSuspendState;
            // bHibernate=false → сон, не гибернация
            let ok = unsafe { SetSuspendState(false, false, false) };
            if ok.as_bool() {
                Ok("Sleeping…".into())
            } else {
                Err("Не удалось перейти в сон".into())
            }
        }
        "empty_trash" => {
            use windows::core::PCWSTR;
            use windows::Win32::UI::Shell::SHEmptyRecycleBinW;
            // NOCONFIRMATION | NOPROGRESSUI | NOSOUND; ошибка = корзина уже пуста
            let hr = unsafe { SHEmptyRecycleBinW(None, PCWSTR::null(), 0x7) };
            if hr.is_ok() {
                Ok("Trash emptied".into())
            } else {
                Ok("Trash is already empty".into())
            }
        }
        "dark_mode" => {
            use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
            use winreg::RegKey;
            let key = RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(
                    r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                    KEY_READ | KEY_WRITE,
                )
                .map_err(|e| e.to_string())?;
            let cur: u32 = key.get_value("AppsUseLightTheme").unwrap_or(1);
            let new: u32 = u32::from(cur == 0);
            key.set_value("AppsUseLightTheme", &new)
                .map_err(|e| e.to_string())?;
            key.set_value("SystemUsesLightTheme", &new)
                .map_err(|e| e.to_string())?;
            broadcast_theme_change();
            Ok(if new == 0 {
                "Dark mode on"
            } else {
                "Dark mode off"
            }
            .into())
        }
        _ => Err(format!("unknown action: {id}")),
    }
    #[cfg(not(windows))]
    Err("only windows".into())
}

/// Сообщаем оболочке о смене темы, иначе часть приложений не подхватит.
#[cfg(windows)]
fn broadcast_theme_change() {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    let param = HSTRING::from("ImmersiveColorSet");
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(param.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            200,
            None,
        );
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/* ============================ SETTINGS ============================ */

const DEFAULT_HOTKEY: &str = "Alt+Space";

/// Настройки — сырой JSON-блоб: Rust интерпретирует только hotkey и tray,
/// остальное (тема, акцент, плагины) потребляет фронт обоих окон.
struct SettingsState(Mutex<serde_json::Value>);

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

fn read_settings_file(app: &AppHandle) -> serde_json::Value {
    settings_file(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
fn get_settings(state: State<'_, SettingsState>) -> serde_json::Value {
    state
        .0
        .lock()
        .map(|v| v.clone())
        .unwrap_or(serde_json::Value::Null)
}

#[tauri::command]
fn set_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    value: serde_json::Value,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        apply_hotkeys(&app, &value)?;
        let tray_on = value
            .get("tray")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        let lang = value.get("lang").and_then(|v| v.as_str()).unwrap_or("en");
        if let Some(tray) = app.tray_by_id("main-tray") {
            let _ = tray.set_visible(tray_on);
            // Смена языка — пересобираем меню трея.
            if let Ok(menu) = build_tray_menu(&app, lang) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    }
    if let Some(p) = settings_file(&app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
        std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
    }
    if let Ok(mut s) = state.0.lock() {
        *s = value.clone();
    }
    let _ = app.emit("settings-changed", value);
    Ok(())
}

/// Цель кастомного бинда: shell:AppsFolder-элементы через explorer,
/// остальное (путь/URL/exe) — как двойной клик.
fn run_bind_target(target: &str) -> Result<(), String> {
    #[cfg(windows)]
    if target.starts_with("shell:") {
        return shell_open_params("explorer.exe", target);
    }
    shell_open(target)
}

/// (Пере)регистрация ВСЕХ глобальных хоткеев: вызов лаунчера + свои бинды
/// из настроек. Снимает прежние; ошибка любого — откат всей записи настроек.
#[cfg(desktop)]
fn apply_hotkeys(app: &AppHandle, settings: &serde_json::Value) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let hk = settings
        .get("hotkey")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_HOTKEY);
    let sc: Shortcut = hk
        .parse()
        .map_err(|e| format!("Bad hotkey '{hk}': {e:?}"))?;
    let handle = app.clone();
    gs.on_shortcut(sc, move |_app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_window(&handle);
        }
    })
    .map_err(|e| e.to_string())?;

    if let Some(binds) = settings.get("binds").and_then(|v| v.as_array()) {
        for b in binds {
            let (Some(hk), Some(target)) = (
                b.get("hotkey").and_then(|v| v.as_str()),
                b.get("target").and_then(|v| v.as_str()),
            ) else {
                continue;
            };
            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or(hk);
            let sc: Shortcut = hk
                .parse()
                .map_err(|e| format!("'{name}': bad hotkey '{hk}': {e:?}"))?;
            let target = target.to_string();
            gs.on_shortcut(sc, move |_app, _sc, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = run_bind_target(&target);
                }
            })
            .map_err(|e| format!("'{name}': {e}"))?;
        }
    }
    Ok(())
}

fn show_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Спотлайт-позиция: по центру, верхняя треть экрана.
fn position_spotlight(w: &tauri::WebviewWindow) {
    if let (Ok(Some(mon)), Ok(size)) = (w.current_monitor(), w.outer_size()) {
        let mpos = mon.position();
        let msize = mon.size();
        let x = mpos.x + (msize.width.saturating_sub(size.width) / 2) as i32;
        let y = mpos.y + (f64::from(msize.height) * 0.16) as i32;
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    } else {
        let _ = w.center();
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            position_spotlight(&w);
            let _ = w.show();
            let _ = w.set_focus();
            let _ = app.emit("focus-input", ());
        }
    }
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        position_spotlight(&w);
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit("focus-input", ());
    }
}

/// Подписи трей-меню: [открыть, настройки, автозапуск, выход].
#[cfg(desktop)]
fn tray_labels(lang: &str) -> [&'static str; 4] {
    match lang {
        "ru" => ["Открыть", "Настройки…", "Запускать при входе", "Выход"],
        "uk" => [
            "Відкрити",
            "Налаштування…",
            "Запускати під час входу",
            "Вийти",
        ],
        "de" => [
            "Öffnen",
            "Einstellungen…",
            "Bei Anmeldung starten",
            "Beenden",
        ],
        "es" => ["Abrir", "Ajustes…", "Abrir al iniciar sesión", "Salir"],
        "fr" => ["Ouvrir", "Réglages…", "Lancer à la connexion", "Quitter"],
        "it" => ["Apri", "Impostazioni…", "Avvia all'accesso", "Esci"],
        "pt" => ["Abrir", "Configurações…", "Iniciar ao entrar", "Sair"],
        "pl" => [
            "Otwórz",
            "Ustawienia…",
            "Uruchamiaj przy logowaniu",
            "Zakończ",
        ],
        "tr" => ["Aç", "Ayarlar…", "Oturum açılınca başlat", "Çıkış"],
        "zh" => ["打开", "设置…", "登录时启动", "退出"],
        "ja" => ["開く", "設定…", "ログイン時に起動", "終了"],
        "ko" => ["열기", "설정…", "로그인 시 실행", "종료"],
        "ar" => ["فتح", "الإعدادات…", "التشغيل عند تسجيل الدخول", "خروج"],
        "fa" => ["باز کردن", "تنظیمات…", "اجرا هنگام ورود", "خروج"],
        "id" => ["Buka", "Pengaturan…", "Jalankan saat masuk", "Keluar"],
        "hi" => ["खोलें", "सेटिंग्स…", "लॉगिन पर चलाएँ", "बाहर निकलें"],
        _ => ["Open", "Settings…", "Launch at login", "Quit"],
    }
}

/// Меню трея на нужном языке (пересобирается при смене языка в настройках).
#[cfg(desktop)]
fn build_tray_menu(app: &AppHandle, lang: &str) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
    use tauri_plugin_autostart::ManagerExt;

    let l = tray_labels(lang);
    let open_i = MenuItem::with_id(app, "open", l[0], true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", l[1], true, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart_i =
        CheckMenuItem::with_id(app, "autostart", l[2], true, autostart_on, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", l[3], true, None::<&str>)?;
    Menu::with_items(app, &[&open_i, &settings_i, &autostart_i, &sep, &quit_i])
}

/// Системный трей: иконка + меню, ЛКМ по иконке — показать окно.
#[cfg(desktop)]
fn build_tray(app: &AppHandle, lang: &str) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri_plugin_autostart::ManagerExt;

    let menu = build_tray_menu(app, lang)?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Nexalix Agora")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "settings" => show_settings(app),
            "autostart" => {
                let mgr = app.autolaunch();
                let enabled = mgr.is_enabled().unwrap_or(false);
                let _ = if enabled { mgr.disable() } else { mgr.enable() };
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

// Точка входа: паника при инициализации Tauri — невосстановимый баг старта,
// а не рантайм-путь. expect здесь оправдан.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[allow(clippy::expect_used, clippy::missing_panics_doc)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(IconCache::default())
        .invoke_handler(tauri::generate_handler![
            index_apps,
            recent_files,
            app_icon,
            open_path,
            open_url,
            run_action,
            get_settings,
            set_settings,
            quit
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                app.handle()
                    .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;

                // Настройки: файл -> state; хоткеи из настроек (fallback Alt+Space).
                let initial = read_settings_file(app.handle());
                let tray_enabled = initial
                    .get("tray")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);
                let lang = initial
                    .get("lang")
                    .and_then(|v| v.as_str())
                    .unwrap_or("en")
                    .to_string();
                let autoupdate = initial
                    .get("autoupdate")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);

                if let Err(e) = apply_hotkeys(app.handle(), &initial) {
                    // Хоткей занят/битый — пробуем дефолты, иначе живём через трей.
                    eprintln!("nexalix-agora: {e}");
                    let _ = apply_hotkeys(app.handle(), &serde_json::json!({}));
                }
                app.manage(SettingsState(Mutex::new(initial)));

                // Тихая проверка обновлений при старте. NSIS ставится silent,
                // приложение перезапускается установщиком. Ошибки глотаем —
                // нет сети/релиза ещё нет — не повод шуметь.
                if autoupdate {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        use tauri_plugin_updater::UpdaterExt;
                        let Ok(updater) = handle.updater() else {
                            return;
                        };
                        if let Ok(Some(update)) = updater.check().await {
                            let _ = update.download_and_install(|_, _| {}, || {}).await;
                        }
                    });
                }

                // Автозапуск включаем по умолчанию только при первом запуске.
                if let Ok(dir) = app.path().app_config_dir() {
                    let marker = dir.join(".autostart-initialized");
                    if !marker.exists() {
                        let _ = std::fs::create_dir_all(&dir);
                        let _ = app.autolaunch().enable();
                        let _ = std::fs::write(&marker, b"1");
                    }
                }

                // При автозапуске на логине explorer может ещё не поднять панель
                // задач — Shell_NotifyIcon падает. Ретраим, setup не роняем.
                let handle = app.handle().clone();
                let mut tray_ok = build_tray(&handle, &lang).is_ok();
                if !tray_ok {
                    for _ in 0..40 {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        if build_tray(&handle, &lang).is_ok() {
                            tray_ok = true;
                            break;
                        }
                    }
                }
                if !tray_ok {
                    eprintln!("nexalix-agora: tray icon failed to initialize after retries");
                } else if !tray_enabled {
                    if let Some(tray) = handle.tray_by_id("main-tray") {
                        let _ = tray.set_visible(false);
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Спотлайт прячется при потере фокуса (только главное окно —
            // настройки живут как обычное окно).
            // NEXALIX_NOHIDE=1 отключает это (для отладки/скриншотов).
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "main" && std::env::var_os("NEXALIX_NOHIDE").is_none() {
                    let _ = window.hide();
                }
            }
            // Крестик/Alt+F4 прячут, не закрывают.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
