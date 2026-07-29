use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// SSH-плагин: хосты из ssh_config, проба доступности, запуск терминала.
mod ssh;

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
            v.sort_by_key(|e| e.name.to_lowercase());
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
    v.sort_by_key(|x| std::cmp::Reverse(x.0));
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
        "game_mode" => set_pc_mode(true),
        "work_mode" => set_pc_mode(false),
        _ => Err(format!("unknown action: {id}")),
    }
    #[cfg(not(windows))]
    Err("only windows".into())
}

#[cfg(windows)]
use windows::core::GUID;
#[cfg(windows)]
use windows::Win32::Foundation::ERROR_SUCCESS;
#[cfg(windows)]
use windows::Win32::System::Registry::HKEY;

/// Схемы питания читаем через powrprof, а не парсингом `powercfg /list`:
/// имена схем локализованы и приходят в OEM-кодировке консоли — из вывода их
/// не собрать. Заодно не мигает окно консоли. Все вызовы идут в HKEY текущего
/// пользователя, а это NULL.
#[cfg(windows)]
const NO_HKEY: HKEY = HKEY(std::ptr::null_mut());

/// Стандартные схемы Windows — фолбэк, если своих GAME/WORK нет.
#[cfg(windows)]
const STD_HIGH_PERF: GUID = GUID::from_u128(0x8c5e_7fda_e8bf_4a96_9a85_a6e2_3a8c_635c);
#[cfg(windows)]
const STD_BALANCED: GUID = GUID::from_u128(0x381b_4222_f694_41f0_9685_ff5b_b260_df2e);

/// Отображаемое имя схемы (UTF-16 из powrprof). Пусто, если API его не отдал.
#[cfg(windows)]
fn scheme_name(guid: &GUID) -> String {
    use windows::Win32::System::Power::PowerReadFriendlyName;

    // Первый вызов с пустым буфером — узнать нужный размер в байтах.
    let mut size: u32 = 0;
    if unsafe { PowerReadFriendlyName(NO_HKEY, Some(guid), None, None, None, &mut size) }
        != ERROR_SUCCESS
    {
        return String::new();
    }
    let mut buf = vec![0u8; size as usize];
    if unsafe {
        PowerReadFriendlyName(
            NO_HKEY,
            Some(guid),
            None,
            None,
            Some(buf.as_mut_ptr()),
            &mut size,
        )
    } != ERROR_SUCCESS
    {
        return String::new();
    }
    let utf16: Vec<u16> = buf
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&c| c != 0)
        .collect();
    String::from_utf16_lossy(&utf16)
}

/// Все схемы питания системы: [(guid, имя)] в порядке `powercfg /list`.
#[cfg(windows)]
fn power_schemes() -> Vec<(GUID, String)> {
    use windows::Win32::System::Power::{PowerEnumerate, ACCESS_SCHEME};

    let mut v = Vec::new();
    let mut index = 0u32;
    loop {
        let mut guid = GUID::from_u128(0);
        let mut size = std::mem::size_of::<GUID>() as u32;
        let rc = unsafe {
            PowerEnumerate(
                NO_HKEY,
                None,
                None,
                ACCESS_SCHEME,
                index,
                Some(std::ptr::from_mut(&mut guid).cast::<u8>()),
                &mut size,
            )
        };
        // Конец списка (ERROR_NO_MORE_ITEMS) или ошибка — дальше не идём.
        if rc != ERROR_SUCCESS {
            return v;
        }
        let name = scheme_name(&guid);
        v.push((guid, name));
        index += 1;
    }
}

/// GUID активной схемы питания.
#[cfg(windows)]
fn active_scheme() -> Option<GUID> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::System::Power::PowerGetActiveScheme;

    let mut p: *mut GUID = std::ptr::null_mut();
    if unsafe { PowerGetActiveScheme(NO_HKEY, &mut p) } != ERROR_SUCCESS || p.is_null() {
        return None;
    }
    let guid = unsafe { *p };
    // Буфер выделен системой через LocalAlloc — освобождаем его.
    let _ = unsafe { LocalFree(HLOCAL(p.cast())) };
    Some(guid)
}

/// Канонический `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` — в таком виде GUID
/// уходит на фронт.
#[cfg(windows)]
fn guid_str(g: &GUID) -> String {
    let d = g.data4;
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        g.data1, g.data2, g.data3, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]
    )
}

/// Обратный разбор: всё, что пришло с фронта, попадает в Win32 только отсюда.
#[cfg(windows)]
fn parse_guid(s: &str) -> Option<GUID> {
    let b = s.as_bytes();
    if b.len() != 36 || [8, 13, 18, 23].iter().any(|&i| b[i] != b'-') {
        return None;
    }
    let hex: String = s.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u128::from_str_radix(&hex, 16).ok().map(GUID::from_u128)
}

/// Схема под режим: сперва пользовательская с именем GAME/WORK, иначе
/// стандартная Windows. На машинах, где стандартные схемы удалены,
/// работает только первый путь — поэтому имя приоритетнее.
#[cfg(windows)]
fn scheme_for(game: bool) -> Option<GUID> {
    let want = if game { "GAME" } else { "WORK" };
    let schemes = power_schemes();
    if let Some((g, _)) = schemes.iter().find(|(_, n)| n.eq_ignore_ascii_case(want)) {
        return Some(*g);
    }
    let std_guid = if game { STD_HIGH_PERF } else { STD_BALANCED };
    schemes
        .iter()
        .find(|(g, _)| *g == std_guid)
        .map(|(g, _)| *g)
}

/// Какой режим ПК активен сейчас: `game` | `work` | `""` (ни то, ни другое).
/// Определяем по активной схеме питания — она же главный переключатель режима.
#[cfg(windows)]
#[tauri::command]
fn pc_mode() -> String {
    let Some(active) = active_scheme() else {
        return String::new();
    };
    if let Some((_, name)) = power_schemes().iter().find(|(g, _)| *g == active) {
        if name.eq_ignore_ascii_case("GAME") {
            return "game".into();
        }
        if name.eq_ignore_ascii_case("WORK") {
            return "work".into();
        }
    }
    if active == STD_HIGH_PERF {
        "game".into()
    } else if active == STD_BALANCED {
        "work".into()
    } else {
        String::new()
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn pc_mode() -> String {
    String::new()
}

/// Схема питания для списка в лаунчере.
#[derive(Serialize)]
struct PowerPlan {
    guid: String,
    name: String,
    active: bool,
}

/// Все схемы из системы (те же, что в `powercfg.cpl`) — для выбора в лаунчере.
/// GAME/WORK тоже отдаём: как схемы они переключают только питание, а действия
/// «игровой/рабочий режим» вдобавок трогают Game Mode и уведомления.
#[cfg(windows)]
#[tauri::command]
fn power_plans() -> Vec<PowerPlan> {
    let active = active_scheme();
    power_schemes()
        .into_iter()
        .filter(|(_, name)| !name.is_empty())
        .map(|(g, name)| PowerPlan {
            guid: guid_str(&g),
            name,
            active: active == Some(g),
        })
        .collect()
}

#[cfg(not(windows))]
#[tauri::command]
fn power_plans() -> Vec<PowerPlan> {
    Vec::new()
}

/// Сделать схему активной.
#[cfg(windows)]
#[tauri::command]
fn set_power_plan(guid: String) -> Result<(), String> {
    use windows::Win32::System::Power::PowerSetActiveScheme;

    let g = parse_guid(&guid).ok_or("bad guid")?;
    let rc = unsafe { PowerSetActiveScheme(NO_HKEY, Some(&g)) };
    if rc == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("powrprof: {}", rc.0))
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn set_power_plan(_guid: String) -> Result<(), String> {
    Err("only windows".into())
}

/// Игровой/рабочий режим ПК. Три обратимых переключателя:
/// схема питания, Windows Game Mode, тихие уведомления (аналог «Не беспокоить»).
/// `game=true` — максимум производительности и тишина; `false` — сбалансированно.
#[cfg(windows)]
fn set_pc_mode(game: bool) -> Result<String, String> {
    use windows::Win32::System::Power::PowerSetActiveScheme;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    // 1) Схема питания: сперва своя GAME/WORK, иначе стандартная Windows.
    // Если ни той, ни другой нет — питание не трогаем, остальное применяем.
    if let Some(scheme) = scheme_for(game) {
        let rc = unsafe { PowerSetActiveScheme(NO_HKEY, Some(&scheme)) };
        if rc != ERROR_SUCCESS {
            return Err(format!("powrprof: {}", rc.0));
        }
    }

    // Запись DWORD в HKCU: открываем на KEY_WRITE (у системных ключей вроде
    // PushNotifications KEY_ALL_ACCESS из create_subkey запрещён), ключ создаём
    // только если его ещё нет.
    let set_dword = |path: &str, name: &str, val: u32| {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu
            .open_subkey_with_flags(path, KEY_WRITE)
            .or_else(|_| hkcu.create_subkey(path).map(|(k, _)| k));
        if let Ok(k) = key {
            let _ = k.set_value(name, &val);
        }
    };
    let flag = u32::from(game);

    // 2) Windows Game Mode.
    set_dword(r"Software\Microsoft\GameBar", "AutoGameModeEnabled", flag);
    set_dword(r"Software\Microsoft\GameBar", "AllowAutoGameMode", flag);

    // 3) «Не беспокоить»: гасим всплывающие уведомления в игре, возвращаем в работе.
    set_dword(
        r"Software\Microsoft\Windows\CurrentVersion\PushNotifications",
        "ToastEnabled",
        u32::from(!game),
    );

    Ok(if game { "Game mode on" } else { "Work mode on" }.into())
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
        .map_or(serde_json::Value::Null, |v| v.clone())
}

#[tauri::command]
fn set_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    value: serde_json::Value,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if let Err(e) = apply_hotkeys(&app, &value) {
            // Ошибка регистрации могла оставить хоткеи частично снятыми —
            // возвращаем прежний набор, чтобы вызов лаунчера не умер.
            let prev = state
                .0
                .lock()
                .map_or_else(|_| serde_json::json!({}), |v| v.clone());
            if apply_hotkeys(&app, &prev).is_err() {
                // Прежний набор тоже не регистрируется (например, его хоткей
                // занят другим приложением) — не оставляем ноль хоткеев,
                // поднимаем дефолтный Alt+Space.
                let _ = apply_hotkeys(&app, &serde_json::json!({}));
            }
            return Err(e);
        }
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
    // Выключили историю буфера — немедленно стираем накопленное из памяти.
    if value
        .get("plugins")
        .and_then(|p| p.get("clipboard"))
        .and_then(serde_json::Value::as_bool)
        == Some(false)
    {
        clip_clear(&app);
    }
    let _ = app.emit("settings-changed", value);
    Ok(())
}

/* ======================= CLIPBOARD HISTORY ======================= */
// История копирований — только в памяти (не на диск: приватность). Фоновый
// поток опрашивает GetClipboardSequenceNumber (дёшево, без открытия буфера);
// на смене — читает CF_UNICODETEXT, кладёт в кольцо (последние 50, дедуп).
// Уважает opt-out парольных менеджеров (ExcludeClipboardContentFromMonitorProcessing).

use std::collections::VecDeque;

struct ClipboardState(Mutex<VecDeque<String>>);

const CLIP_MAX: usize = 50;
const CLIP_TEXT_CAP: usize = 20_000;
// Стабильная ABI-константа формата (не тянем Win32_System_Ole ради CF_UNICODETEXT).
#[cfg(windows)]
const CF_UNICODETEXT_U32: u32 = 13;

enum ClipRead {
    Retry, // буфер занят другим процессом — повторить на следующем тике
    Skip,  // не текст / исключён / пусто — просто пропустить
    Text(String),
}

#[cfg(windows)]
fn wide_z(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn read_clipboard_text() -> ClipRead {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    // SAFETY: OpenClipboard парен CloseClipboard на каждом пути выхода; читаем
    // заблокированную GlobalLock память в пределах GlobalSize, снимаем GlobalUnlock.
    unsafe {
        if OpenClipboard(None).is_err() {
            return ClipRead::Retry;
        }
        let exclude_name = wide_z("ExcludeClipboardContentFromMonitorProcessing");
        let exclude = RegisterClipboardFormatW(PCWSTR(exclude_name.as_ptr()));
        if exclude != 0 && IsClipboardFormatAvailable(exclude).is_ok() {
            let _ = CloseClipboard();
            return ClipRead::Skip; // менеджер паролей запретил историю
        }
        // Второй стандартный opt-out истории Windows: CanIncludeInClipboardHistory
        // присутствует и его DWORD == 0.
        let cich_name = wide_z("CanIncludeInClipboardHistory");
        let cich = RegisterClipboardFormatW(PCWSTR(cich_name.as_ptr()));
        if cich != 0 && IsClipboardFormatAvailable(cich).is_ok() {
            if let Ok(h) = GetClipboardData(cich) {
                if !h.is_invalid() {
                    let hg = HGLOBAL(h.0);
                    let p = GlobalLock(hg).cast::<u32>();
                    let excluded = !p.is_null() && *p == 0;
                    if !p.is_null() {
                        let _ = GlobalUnlock(hg);
                    }
                    if excluded {
                        let _ = CloseClipboard();
                        return ClipRead::Skip;
                    }
                }
            }
        }
        if IsClipboardFormatAvailable(CF_UNICODETEXT_U32).is_err() {
            let _ = CloseClipboard();
            return ClipRead::Skip; // не текст (картинка/файлы)
        }
        let text = match GetClipboardData(CF_UNICODETEXT_U32) {
            Ok(h) if !h.is_invalid() => {
                let hg = HGLOBAL(h.0);
                let ptr = GlobalLock(hg).cast::<u16>();
                if ptr.is_null() {
                    None
                } else {
                    let max_len = GlobalSize(hg) / 2;
                    let mut len = 0usize;
                    while len < max_len && *ptr.add(len) != 0 {
                        len += 1;
                    }
                    let slice = std::slice::from_raw_parts(ptr, len);
                    let s = String::from_utf16_lossy(slice);
                    let _ = GlobalUnlock(hg);
                    Some(s)
                }
            }
            _ => None,
        };
        let _ = CloseClipboard();
        match text {
            Some(s) if !s.trim().is_empty() => {
                let s: String = s.chars().take(CLIP_TEXT_CAP).collect();
                ClipRead::Text(s)
            }
            _ => ClipRead::Skip,
        }
    }
}

#[cfg(windows)]
fn set_clipboard_text(s: &str) -> Result<(), String> {
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    let data = wide_z(s);
    // SAFETY: hg готовим ДО OpenClipboard/EmptyClipboard — иначе сбой оставил бы
    // пользователя с пустым буфером. На любой ошибке освобождаем hg; после
    // успешного SetClipboardData владение hg переходит системе (не освобождаем).
    unsafe {
        let hg: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, data.len() * 2).map_err(|e| e.to_string())?;
        let ptr = GlobalLock(hg).cast::<u16>();
        if ptr.is_null() {
            let _ = GlobalFree(hg);
            return Err("GlobalLock failed".into());
        }
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        let _ = GlobalUnlock(hg);

        if let Err(e) = OpenClipboard(None) {
            let _ = GlobalFree(hg);
            return Err(e.to_string());
        }
        let res = (|| -> Result<(), String> {
            EmptyClipboard().map_err(|e| e.to_string())?;
            SetClipboardData(CF_UNICODETEXT_U32, HANDLE(hg.0)).map_err(|e| e.to_string())?;
            Ok(())
        })();
        let _ = CloseClipboard();
        if res.is_err() {
            let _ = GlobalFree(hg); // владение не перешло системе — освобождаем
        }
        res
    }
}

#[cfg(not(windows))]
fn read_clipboard_text() -> ClipRead {
    ClipRead::Skip
}
#[cfg(not(windows))]
fn set_clipboard_text(_s: &str) -> Result<(), String> {
    Err("clipboard unsupported on this platform".into())
}

fn clip_push(app: &AppHandle, s: String) {
    if let Some(state) = app.try_state::<ClipboardState>() {
        if let Ok(mut dq) = state.0.lock() {
            dq.retain(|x| x != &s); // дедуп: старое вхождение убираем
            dq.push_front(s);
            while dq.len() > CLIP_MAX {
                dq.pop_back();
            }
        }
    }
}

/// Плагин истории буфера включён? (дефолт — да). Настройка живёт в SettingsState.
fn clipboard_enabled(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<SettingsState>() else {
        return true;
    };
    let Ok(v) = state.0.lock() else {
        return true;
    };
    v.get("plugins")
        .and_then(|p| p.get("clipboard"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

/// Стереть собранную историю из памяти (при отключении плагина).
fn clip_clear(app: &AppHandle) {
    if let Some(state) = app.try_state::<ClipboardState>() {
        if let Ok(mut dq) = state.0.lock() {
            dq.clear();
        }
    }
}

#[cfg(windows)]
fn spawn_clipboard_watcher(app: AppHandle) {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    std::thread::spawn(move || {
        let mut last = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(600));
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == last {
                continue;
            }
            // Отключено пользователем — не собираем и чистим уже собранное.
            if !clipboard_enabled(&app) {
                clip_clear(&app);
                last = seq;
                continue;
            }
            match read_clipboard_text() {
                ClipRead::Retry => {} // буфер занят — не двигаем last, повторим
                ClipRead::Skip => last = seq,
                ClipRead::Text(s) => {
                    last = seq;
                    clip_push(&app, s);
                }
            }
        }
    });
}

#[cfg(not(windows))]
fn spawn_clipboard_watcher(_app: AppHandle) {}

#[tauri::command]
fn clipboard_history(app: AppHandle, state: State<'_, ClipboardState>) -> Vec<String> {
    if !clipboard_enabled(&app) {
        return Vec::new();
    }
    state
        .0
        .lock()
        .map(|dq| dq.iter().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
fn set_clipboard(text: String) -> Result<(), String> {
    set_clipboard_text(&text)
}

/* ======================= PROCESSES (kill) ======================= */
// Список процессов (имя+pid+рабочее множество) и завершение по pid. Фронт
// показывает список и «помогает выбрать» — Enter на строке шлёт kill_process(pid).

#[derive(Serialize, Clone)]
struct ProcInfo {
    pid: u32,
    name: String,
    mem: u64, // working set, байты
}

/// Всегда-критические образы: их завершение роняет систему (CRITICAL_PROCESS_DIED).
/// Первый барьер (не показываем в списке); второй — IsProcessCritical в kill_process.
fn is_critical_name(name: &str) -> bool {
    const CRIT: &[&str] = &[
        "csrss.exe",
        "wininit.exe",
        "winlogon.exe",
        "services.exe",
        "lsass.exe",
        "smss.exe",
        "system",
        "registry",
    ];
    let n = name.to_ascii_lowercase();
    CRIT.contains(&n.as_str())
}

#[cfg(windows)]
#[tauri::command]
fn list_processes() -> Vec<ProcInfo> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let self_pid = std::process::id();
    let mut out: Vec<ProcInfo> = Vec::new();
    // SAFETY: снапшот закрываем; заполняем только переданную PROCESSENTRY32W
    // (dwSize выставлен перед Process32FirstW).
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let pid = e.th32ProcessID;
                let n = e
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..n]);
                // Прячем: System (0/4), себя и свои дочерние (WebView2), критические
                // системные процессы (их завершение = BSOD).
                if pid != 0
                    && pid != 4
                    && pid != self_pid
                    && e.th32ParentProcessID != self_pid
                    && !name.is_empty()
                    && !is_critical_name(&name)
                {
                    out.push(ProcInfo {
                        pid,
                        name,
                        mem: proc_working_set(pid),
                    });
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    // Крупные потребители памяти — сверху (их чаще и «килляют»).
    out.sort_by_key(|b| std::cmp::Reverse(b.mem));
    out
}

#[cfg(windows)]
fn proc_working_set(pid: u32) -> u64 {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // SAFETY: хэндл закрываем; GetProcessMemoryInfo заполняет переданную структуру.
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return 0;
        };
        let mut pmc = PROCESS_MEMORY_COUNTERS::default();
        let cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ws = if GetProcessMemoryInfo(h, &mut pmc, cb).is_ok() {
            pmc.WorkingSetSize as u64
        } else {
            0
        };
        let _ = CloseHandle(h);
        ws
    }
}

/// Имя exe-файла процесса по открытому хэндлу (QueryFullProcessImageNameW).
#[cfg(windows)]
fn image_file_name(h: windows::Win32::Foundation::HANDLE) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::System::Threading::{QueryFullProcessImageNameW, PROCESS_NAME_WIN32};

    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: буфер валиден, len — его ёмкость; API пишет не больше len UTF-16 юнитов.
    unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }
        .ok()?;
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    full.rsplit(['\\', '/']).next().map(str::to_string)
}

#[cfg(windows)]
#[tauri::command]
fn kill_process(pid: u32) -> Result<(), String> {
    use windows::Win32::Foundation::{CloseHandle, BOOL, ERROR_ACCESS_DENIED};
    use windows::Win32::System::Threading::{
        IsProcessCritical, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    };

    // SAFETY: хэндл закрываем на всех путях; Is/Terminate принимают валидный хэндл.
    unsafe {
        let h = match OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid,
        ) {
            Ok(h) => h,
            // Точная причина вместо всегда-«нужен админ»: мёртвый pid, PPL и т.п.
            Err(e) if e.code() == ERROR_ACCESS_DENIED.to_hresult() => {
                return Err("Нет доступа (нужны права администратора)".into());
            }
            Err(e) => return Err(e.message()),
        };
        // Денилист имён повторно, уже по pid из IPC (list_processes фильтрует
        // только выдачу): под админом IsProcessCritical не флагает lsass/services,
        // а их завершение форсит перезагрузку системы.
        if image_file_name(h).is_some_and(|n| is_critical_name(&n)) {
            let _ = CloseHandle(h);
            return Err("Критический системный процесс — завершение запрещено".into());
        }
        // Критический процесс (ProcessBreakOnTermination) — завершение = BSOD.
        // Второй барьер к денилисту имён: отказываем даже под админом.
        let mut crit = BOOL::default();
        if IsProcessCritical(h, &mut crit).is_ok() && crit.as_bool() {
            let _ = CloseHandle(h);
            return Err("Критический системный процесс — завершение запрещено".into());
        }
        let res = TerminateProcess(h, 1).map_err(|e| e.to_string());
        let _ = CloseHandle(h);
        res
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn list_processes() -> Vec<ProcInfo> {
    Vec::new()
}
#[cfg(not(windows))]
#[tauri::command]
fn kill_process(_pid: u32) -> Result<(), String> {
    Err("process control unsupported on this platform".into())
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
/// из настроек. Сначала парсит всё (битый хоткей не снимает работающие),
/// только потом перерегистрирует; ошибку регистрации откатывает set_settings.
#[cfg(desktop)]
fn apply_hotkeys(app: &AppHandle, settings: &serde_json::Value) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    let hk = settings
        .get("hotkey")
        .and_then(|v| v.as_str())
        .unwrap_or(DEFAULT_HOTKEY);
    let main_sc: Shortcut = hk
        .parse()
        .map_err(|e| format!("Bad hotkey '{hk}': {e:?}"))?;

    let mut bind_scs: Vec<(Shortcut, String, String)> = Vec::new();
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
            bind_scs.push((sc, name.to_string(), target.to_string()));
        }
    }

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let handle = app.clone();
    gs.on_shortcut(main_sc, move |_app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_window(&handle);
        }
    })
    .map_err(|e| e.to_string())?;

    for (sc, name, target) in bind_scs {
        gs.on_shortcut(sc, move |_app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = run_bind_target(&target);
            }
        })
        .map_err(|e| format!("'{name}': {e}"))?;
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

/// Полный `MONITORINFO` монитора под курсором мыши (физические px виртуального
/// рабочего стола). Процесс per-monitor-v2 DPI-aware (Tauri v2 через tao),
/// поэтому GetCursorPos, MonitorFromPoint и rcMonitor/rcWork живут в одном
/// координатном пространстве — без DPI-коррекции.
#[cfg(windows)]
fn cursor_monitor_info() -> Option<windows::Win32::Graphics::Gdi::MONITORINFO> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut pt = POINT::default();
    // SAFETY: pt — валидный &mut POINT; вызовы лишь заполняют переданные структуры.
    unsafe { GetCursorPos(&mut pt) }.ok()?;
    let mon = unsafe { MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST) };
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetMonitorInfoW(mon, &mut mi) }.as_bool() {
        Some(mi)
    } else {
        None
    }
}

/// Спотлайт-позиция: центр монитора ПОД КУРСОРОМ, верхняя треть.
/// Монитор берём по мыши (сигнал «где сейчас пользователь»), а не по
/// current_monitor() — скрытое окно всё ещё числится на старом (обычно
/// главном) мониторе, из-за чего лаунчер всегда открывался не там.
fn position_spotlight(w: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Some(mi) = cursor_monitor_info() {
        let m = mi.rcMonitor;
        // Шаг 1: перенести окно на целевой монитор. Если у него DPI отличается
        // от текущего (2K@150% vs FHD@100%), tao по WM_DPICHANGED сам ресайзит
        // окно под масштаб цели. set_position с не-main потока асинхронный, но
        // блокирующий outer_size() ниже — барьер: событийный цикл FIFO, к моменту
        // его ответа перенос и смена DPI уже применены.
        let _ = w.set_position(tauri::PhysicalPosition::new(m.left, m.top));
        // Шаг 2: outer_size уже в физ. px целевого монитора → точный центр по
        // горизонтали независимо от разрешения/масштаба.
        if let Ok(size) = w.outer_size() {
            let x = m.left + ((m.right - m.left) - size.width as i32) / 2;
            let y = m.top + (f64::from(m.bottom - m.top) * 0.16) as i32;
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
            return;
        }
    }

    // Деградация (GetCursorPos не сработал / нет монитора): current_monitor → center.
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
#[allow(
    clippy::expect_used,
    clippy::missing_panics_doc,
    clippy::too_many_lines
)]
pub fn run() {
    tauri::Builder::default()
        // Первым: повторный запуск exe не плодит второй трей/watcher,
        // а показывает лаунчер уже работающего экземпляра. Колбэк может
        // прилететь до создания окна «main» (WebView2 качает сообщения при
        // старте) — show_window тогда тихий no-op, это осознанно.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(IconCache::default())
        .manage(ClipboardState(Mutex::new(VecDeque::new())))
        .invoke_handler(tauri::generate_handler![
            index_apps,
            recent_files,
            app_icon,
            open_path,
            open_url,
            run_action,
            pc_mode,
            power_plans,
            set_power_plan,
            get_settings,
            set_settings,
            clipboard_history,
            set_clipboard,
            list_processes,
            kill_process,
            ssh::ssh_hosts,
            ssh::ssh_probe,
            ssh::ssh_client_present,
            ssh::ssh_wt_profiles,
            ssh::ssh_open,
            ssh::ssh_add_host,
            ssh::ssh_remove_host,
            ssh::ssh_keys,
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
                let mut initial = initial;
                if let Err(e) = apply_hotkeys(app.handle(), &initial) {
                    // Хоткей занят/битый — пробуем дефолты, иначе живём через трей.
                    eprintln!("nexalix-agora: {e}");
                    if apply_hotkeys(app.handle(), &serde_json::json!({})).is_ok() {
                        // Состояние должно отражать реально активный хоткей —
                        // иначе любой set_settings перерегистрирует битый и
                        // снесёт работающий дефолтный.
                        if let Some(o) = initial.as_object_mut() {
                            o.insert("hotkey".into(), DEFAULT_HOTKEY.into());
                        }
                    }
                }
                app.manage(SettingsState(Mutex::new(initial)));

                // Фоновый наблюдатель за буфером обмена (история копирований).
                spawn_clipboard_watcher(app.handle().clone());

                // Обновления не ставим за спиной у пользователя: фоновой
                // проверкой и предложением занимается лаунчер (main.ts), а
                // установку запускает уже подтверждение — см. UPDATE там.

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
