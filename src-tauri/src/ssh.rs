//! SSH-плагин: хосты из `~/.ssh/config`, проба доступности, запуск терминала.
//!
//! Состояния нет намеренно: конфиг — десятки строк, читаем его на каждый вызов.
//! Кэш здесь стоил бы инвалидации (файл правят снаружи), а экономил бы микросекунды.
//!
//! Запись в конфиг работает с сырыми байтами. Разбирать конфиг можно и через
//! lossy-декод, а вот записывать так нельзя: файл может быть в cp1251 и с CRLF,
//! и перезапись декодированного текста молча съела бы и то, и другое. Поэтому
//! исходные строки переносятся байт в байт, а меняются только свои блоки —
//! помеченные маркером [`MARKER`].

use std::io::Read;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Порт по умолчанию, когда `Port` в блоке не задан.
const DEFAULT_PORT: u16 = 22;
/// Комментарий-маркер перед блоком, который добавила Agora.
const MARKER: &str = "# agora";
/// Глубина раскрытия `Include` (защита от цепочек и циклов).
const MAX_INCLUDE_DEPTH: u8 = 3;
/// Сколько ждём TCP-соединения на пробе.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
/// Сколько ждём SSH-баннер, прежде чем закрыть сокет.
const BANNER_TIMEOUT: Duration = Duration::from_millis(400);
/// Общий потолок на всю волну проб. Нужен потому, что резолв имени
/// (`to_socket_addrs`) блокирующий и своего таймаута не имеет: без дедлайна
/// одна мёртвая DNS-зона задержала бы ответ на неопределённое время.
const PROBE_DEADLINE: Duration = Duration::from_millis(3500);
/// Верхняя граница одновременных проб (столько же строк показывает лаунчер).
const MAX_PROBES: usize = 14;

/// Хост из ssh_config, пригодный для подключения.
///
/// Поля отражают только то, что задано в блоке явно: наследование из `Host *`
/// не разворачивается, потому что показываем мы именно конкретный блок.
#[derive(Serialize, Clone, Default)]
pub(crate) struct SshHost {
    alias: String,
    hostname: String,
    user: String,
    port: u16,
    identity: String,
    /// Сколько `LocalForward` в блоке — лаунчер рисует бейдж туннеля.
    forwards: u32,
    /// Блок добавлен Agora (помечен маркером) — только такие можно удалять.
    managed: bool,
    /// `Port` встречался явно: дальше первое значение выигрывает, как у ssh.
    #[serde(skip)]
    port_set: bool,
}

/// Чем закончилась проба.
#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
enum PingState {
    /// TCP-соединение установлено.
    Open,
    /// Хост ответил, но на порту никто не слушает.
    Refused,
    /// Ответа не дождались.
    Timeout,
    /// Имя не разрешилось.
    Dns,
}

/// Результат пробы одного хоста.
#[derive(Serialize, Clone)]
pub(crate) struct SshPing {
    alias: String,
    /// Время установления TCP-соединения; `None` во всех неуспешных состояниях.
    ms: Option<u32>,
    state: PingState,
}

/* ============================== ПУТИ ============================== */

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE").ok().map(PathBuf::from)
}

fn ssh_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".ssh"))
}

fn user_config() -> Option<PathBuf> {
    ssh_dir().map(|d| d.join("config"))
}

fn system_config() -> Option<PathBuf> {
    std::env::var("ProgramData")
        .ok()
        .map(|d| PathBuf::from(d).join(r"ssh\ssh_config"))
}

/// Текст для РАЗБОРА: cp1251-комментарии не должны ронять список хостов.
/// Для записи это использовать нельзя — см. модульный комментарий.
fn read_lossy(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Строки файла как есть, вместе с их переводом строки.
fn read_raw_lines(path: &Path) -> Option<Vec<Vec<u8>>> {
    let bytes = std::fs::read(path).ok()?;
    let mut out = Vec::new();
    let mut start = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            out.push(bytes[start..=i].to_vec());
            start = i + 1;
        }
    }
    if start < bytes.len() {
        out.push(bytes[start..].to_vec());
    }
    Some(out)
}

/// Каким переводом строки живёт файл: увидели CRLF — пишем CRLF.
fn newline_of(bytes: &[u8]) -> &'static [u8] {
    if bytes.windows(2).any(|w| w == b"\r\n") {
        b"\r\n"
    } else {
        b"\n"
    }
}

/* ============================== ПАРСЕР ============================== */

/// Алиас, который безопасно отдать в argv и записать в конфиг.
///
/// Первый символ — буква или цифра: алиас, начинающийся с `-`, ssh и wt приняли
/// бы за флаг.
fn valid_alias(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    s.len() <= 64
        && first.is_ascii_alphanumeric()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `Key value` или `Key = value` -> (ключ в нижнем регистре, значение).
/// BOM в начале файла срезаем: `trim` его не трогает (это не пробел), и без
/// этого первый `Host` в файле из Блокнота потерялся бы.
fn split_kv(line: &str) -> Option<(String, &str)> {
    let line = line.trim_start_matches('\u{feff}').trim();
    let idx = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..idx].to_ascii_lowercase();
    let val = line[idx..]
        .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
        .trim();
    Some((key, val))
}

/// Значение директивы без окружающих кавычек (`IdentityFile "C:\a b\key"`).
fn unquote(v: &str) -> &str {
    v.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(v)
}

/// Строка-комментарий (в ssh_config комментарий занимает строку целиком).
fn is_comment(line: &str) -> bool {
    line.trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with('#')
}

fn is_marker(line: &str) -> bool {
    line.trim().eq_ignore_ascii_case(MARKER)
}

/// Директива, открывающая новую секцию верхнего уровня.
fn is_top_level(line: &str) -> bool {
    split_kv(line).is_some_and(|(k, _)| matches!(k.as_str(), "host" | "match" | "include"))
}

/// Единица разбора: хост или ссылка на включаемый файл. Порядок важен —
/// `Include` должен раскрываться ровно на своём месте, иначе first-wins
/// при дублирующихся алиасах сработал бы не так, как у самого ssh.
enum Item {
    Host(Box<SshHost>),
    Include(String),
}

/// Алиас блока `Host`: берём первый паттерн, отбрасывая хвостовой комментарий.
/// Блок с несколькими паттернами или с wildcard — шаблон, а не адрес.
fn host_alias(val: &str) -> Option<&str> {
    let pats: Vec<&str> = val
        .split_whitespace()
        .take_while(|t| !t.starts_with('#'))
        .collect();
    match pats.as_slice() {
        [only] if valid_alias(only) => Some(only),
        _ => None,
    }
}

/// Разбор текста одного конфига. К файловой системе не ходит — тестируем.
///
/// Правила намеренно уже, чем настоящий ssh_config: `Match` пропускаем целиком
/// и условия не вычисляем (вычислить их значило бы выполнить `Match exec`).
fn parse_text(text: &str) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::new();
    let mut cur: Option<SshHost> = None;
    let mut marked = false;

    let close = |cur: &mut Option<SshHost>, out: &mut Vec<Item>| {
        if let Some(h) = cur.take() {
            out.push(Item::Host(Box::new(h)));
        }
    };

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if is_comment(line) {
            // Маркер действует только вплотную перед своим Host.
            marked = is_marker(line);
            continue;
        }
        let Some((key, val)) = split_kv(line) else {
            marked = false;
            continue;
        };
        match key.as_str() {
            "host" => {
                close(&mut cur, &mut out);
                if let Some(alias) = host_alias(val) {
                    cur = Some(SshHost {
                        alias: alias.to_string(),
                        port: DEFAULT_PORT,
                        managed: marked,
                        ..SshHost::default()
                    });
                }
                marked = false;
            }
            "match" => {
                close(&mut cur, &mut out);
                marked = false;
            }
            "include" => {
                close(&mut cur, &mut out);
                out.push(Item::Include(unquote(val).to_string()));
                marked = false;
            }
            _ => {
                marked = false;
                let Some(h) = cur.as_mut() else {
                    continue;
                };
                // Внутри блока первое вхождение выигрывает — как у самого ssh.
                match key.as_str() {
                    "hostname" if h.hostname.is_empty() => h.hostname = unquote(val).to_string(),
                    "user" if h.user.is_empty() => h.user = unquote(val).to_string(),
                    "identityfile" if h.identity.is_empty() => {
                        h.identity = unquote(val).to_string();
                    }
                    "port" if !h.port_set => {
                        if let Ok(p) = val.parse::<u16>() {
                            if p > 0 {
                                h.port = p;
                                h.port_set = true;
                            }
                        }
                    }
                    "localforward" => h.forwards += 1,
                    _ => {}
                }
            }
        }
    }
    close(&mut cur, &mut out);
    out
}

/// Раскрытие одного `Include`: `~` и относительные пути — от `~/.ssh`,
/// поддержан единственный `*` в имени файла (без glob-крейта).
fn expand_include(pattern: &str) -> Vec<PathBuf> {
    let pat = pattern.replace('/', "\\");
    let full = if let Some(rest) = pat.strip_prefix("~\\") {
        match home_dir() {
            Some(h) => h.join(rest),
            None => return Vec::new(),
        }
    } else {
        let p = PathBuf::from(&pat);
        if p.is_absolute() {
            p
        } else {
            match ssh_dir() {
                Some(d) => d.join(p),
                None => return Vec::new(),
            }
        }
    };
    let Some(name) = full.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };
    if !name.contains('*') {
        return vec![full];
    }
    let Some(dir) = full.parent() else {
        return Vec::new();
    };
    let Some((pre, post)) = name.split_once('*') else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| {
            e.file_name().to_str().is_some_and(|n| {
                n.len() >= pre.len() + post.len() && n.starts_with(pre) && n.ends_with(post)
            })
        })
        .map(|e| e.path())
        .collect();
    found.sort();
    found
}

/// Рекурсивный обход файла и его `Include` — в порядке появления директив.
fn collect_from(path: &Path, depth: u8, seen: &mut Vec<PathBuf>, out: &mut Vec<SshHost>) {
    if depth > MAX_INCLUDE_DEPTH {
        return;
    }
    let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if seen.contains(&key) {
        return;
    }
    seen.push(key);
    let Some(text) = read_lossy(path) else {
        return;
    };
    for item in parse_text(&text) {
        match item {
            Item::Host(h) => out.push(*h),
            Item::Include(pattern) => {
                for p in expand_include(&pattern) {
                    collect_from(&p, depth + 1, seen, out);
                }
            }
        }
    }
}

/// Все пригодные к подключению хосты: сначала пользовательский конфиг,
/// затем системный. Дубликаты алиасов схлопываются — первый выигрывает.
fn hosts() -> Vec<SshHost> {
    let mut all = Vec::new();
    let mut seen = Vec::new();
    for p in [user_config(), system_config()].into_iter().flatten() {
        collect_from(&p, 0, &mut seen, &mut all);
    }
    let mut aliases: Vec<String> = Vec::new();
    all.retain(|h| {
        if aliases.contains(&h.alias) {
            return false;
        }
        aliases.push(h.alias.clone());
        true
    });
    for h in &mut all {
        if h.hostname.is_empty() {
            h.hostname.clone_from(&h.alias);
        }
    }
    all
}

#[tauri::command(async)]
pub(crate) fn ssh_hosts() -> Vec<SshHost> {
    hosts()
}

/* ============================== ПРОБА ============================== */

/// Одна проба: TCP-соединение до порта из конфига.
///
/// Перебираем все адреса резолва, как это делает сам ssh: у dual-stack хоста
/// первый адрес вполне может быть недостижим, а второй — рабочим.
///
/// Баннер дочитываем не ради содержимого: если оборвать сессию раньше, sshd на
/// каждую пробу пишет `Did not receive identification string` — шум в логе и
/// повод для fail2ban. Лишний round-trip покупает чистый лог.
fn probe_one(alias: String, host: &str, port: u16) -> SshPing {
    let fail = |state| SshPing {
        alias: alias.clone(),
        ms: None,
        state,
    };
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return fail(PingState::Dns);
    };
    let addrs: Vec<SocketAddr> = addrs.collect();
    if addrs.is_empty() {
        return fail(PingState::Dns);
    }
    // Хост ответил отказом хотя бы по одному адресу — это точнее, чем таймаут.
    let mut worst = PingState::Timeout;
    for addr in addrs {
        let started = Instant::now();
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(mut stream) => {
                let ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
                let _ = stream.set_read_timeout(Some(BANNER_TIMEOUT));
                let mut buf = [0u8; 256];
                let _ = stream.read(&mut buf); // содержимое не важно, важна вежливость
                return SshPing {
                    alias,
                    ms: Some(ms),
                    state: PingState::Open,
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                worst = PingState::Refused;
            }
            Err(_) => {}
        }
    }
    fail(worst)
}

/// Пробует переданные алиасы (обычно — только видимые строки лаунчера).
///
/// `async`, потому что синхронная команда Tauri выполняется на главном потоке:
/// волна проб замораживала бы окно лаунчера на все свои полторы секунды.
/// Результаты собираем каналом с общим дедлайном — поток, застрявший в резолве,
/// не задерживает остальных, а его хост просто останется без индикатора.
#[tauri::command(async)]
pub(crate) fn ssh_probe(aliases: Vec<String>) -> Vec<SshPing> {
    let known = hosts();
    let targets: Vec<(String, String, u16)> = aliases
        .into_iter()
        .take(MAX_PROBES)
        .filter_map(|a| {
            known
                .iter()
                .find(|h| h.alias == a)
                .map(|h| (h.alias.clone(), h.hostname.clone(), h.port))
        })
        .collect();

    let expected = targets.len();
    let (tx, rx) = mpsc::channel();
    for (alias, host, port) in targets {
        let tx = tx.clone();
        std::thread::spawn(move || {
            // Приёмник мог уйти по дедлайну — отправка в закрытый канал не беда.
            let _ = tx.send(probe_one(alias, &host, port));
        });
    }
    drop(tx);

    let deadline = Instant::now() + PROBE_DEADLINE;
    let mut out = Vec::with_capacity(expected);
    while out.len() < expected {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        match rx.recv_timeout(left) {
            Ok(p) => out.push(p),
            Err(_) => break,
        }
    }
    out
}

/* ============================== ЗАПУСК ============================== */

/// Системный OpenSSH, всегда абсолютным путём: голое `ssh` в PATH нередко
/// разрешается в `ssh.exe` из Git for Windows с другими соглашениями.
#[cfg(windows)]
fn ssh_exe() -> Option<PathBuf> {
    system32(r"OpenSSH\ssh.exe")
}

#[cfg(windows)]
fn system32(rel: &str) -> Option<PathBuf> {
    let root = std::env::var("SystemRoot").ok()?;
    let p = PathBuf::from(root).join("System32").join(rel);
    p.exists().then_some(p)
}

/// Windows Terminal — это 0-байтовый reparse point (App Execution Alias),
/// поэтому только проверка существования, никаких проверок размера.
#[cfg(windows)]
fn wt_exe() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let p = PathBuf::from(local).join(r"Microsoft\WindowsApps\wt.exe");
    p.exists().then_some(p)
}

/// Профили Windows Terminal из его `settings.json` — чтобы сессия открывалась
/// в том же оформлении, что и обычная вкладка, а не в профиле по умолчанию.
#[cfg(windows)]
fn wt_settings_path() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let base = PathBuf::from(local);
    [
        r"Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json",
        r"Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json",
        r"Microsoft\Windows Terminal\settings.json",
    ]
    .into_iter()
    .map(|rel| base.join(rel))
    .find(|p| p.exists())
}

/// В settings.json Windows Terminal разрешены `//`-комментарии, которых
/// serde_json не понимает: вырезаем их, не трогая содержимое строк.
#[cfg(windows)]
fn strip_jsonc(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut chars = src.chars().peekable();
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Имена профилей Windows Terminal; первый в списке — профиль по умолчанию.
#[tauri::command(async)]
pub(crate) fn ssh_wt_profiles() -> Vec<String> {
    #[cfg(windows)]
    {
        let Some(path) = wt_settings_path() else {
            return Vec::new();
        };
        let Some(raw) = read_lossy(&path) else {
            return Vec::new();
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&strip_jsonc(&raw)) else {
            return Vec::new();
        };
        let list = json
            .get("profiles")
            .and_then(|p| p.get("list").or(Some(p)))
            .and_then(|l| l.as_array())
            .cloned()
            .unwrap_or_default();
        let default_guid = json.get("defaultProfile").and_then(|g| g.as_str());
        let mut names: Vec<String> = Vec::new();
        for p in &list {
            let Some(name) = p.get("name").and_then(|n| n.as_str()) else {
                continue;
            };
            // Профиль по умолчанию — первым: он же и подсказка «как обычно».
            if p.get("guid").and_then(|g| g.as_str()) == default_guid && default_guid.is_some() {
                names.insert(0, name.to_string());
            } else {
                names.push(name.to_string());
            }
        }
        names
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// PowerShell 7 ставится вне System32: сначала обычная установка, затем Store.
#[cfg(windows)]
fn pwsh_exe() -> Option<PathBuf> {
    let candidates = [
        std::env::var("ProgramFiles")
            .ok()
            .map(|d| PathBuf::from(d).join(r"PowerShell\7\pwsh.exe")),
        std::env::var("LOCALAPPDATA")
            .ok()
            .map(|d| PathBuf::from(d).join(r"Microsoft\WindowsApps\pwsh.exe")),
    ];
    candidates.into_iter().flatten().find(|p| p.exists())
}

/// Дочернему процессу нужна своя консоль: релизная сборка Tauri — приложение
/// подсистемы windows, консоли у него нет.
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// В чём открывать сессию.
///
/// `Direct` — сам `ssh.exe` процессом вкладки: закрылась сессия, закрылась
/// вкладка. Остальные варианты запускают ssh внутри оболочки, поэтому после
/// выхода с сервера вы остаётесь в своём привычном шелле.
#[cfg(windows)]
#[derive(Clone, Copy)]
enum Shell {
    Direct,
    Powershell,
    Pwsh,
    Cmd,
}

#[cfg(windows)]
impl Shell {
    fn parse(s: &str) -> Self {
        match s {
            "powershell" => Self::Powershell,
            "pwsh" => Self::Pwsh,
            "cmd" => Self::Cmd,
            _ => Self::Direct,
        }
    }
}

/// Программа и аргументы сессии для выбранной оболочки.
///
/// Алиас уже прошёл [`valid_alias`] (только `[A-Za-z0-9._-]`, первый символ —
/// буква или цифра), поэтому ни кавычек, ни пробелов, ни ведущего дефиса в нём
/// быть не может — вставка в командную строку оболочки безопасна.
#[cfg(windows)]
fn session_argv(shell: Shell, ssh: &Path, alias: &str) -> (PathBuf, Vec<String>) {
    /// Запасной вариант для всех веток: сам ssh, без оболочки.
    fn direct(ssh: &Path, alias: &str) -> (PathBuf, Vec<String>) {
        (ssh.to_path_buf(), vec![alias.to_string()])
    }
    /// `-NoExit` оставляет оболочку живой после выхода с сервера. Кавычки
    /// одинарные: в PowerShell это литерал, а апострофов ни в пути к ssh,
    /// ни в проверенном алиасе быть не может.
    fn in_powershell(exe: PathBuf, ssh: &Path, alias: &str) -> (PathBuf, Vec<String>) {
        let ssh_str = ssh.display().to_string();
        (
            exe,
            vec![
                "-NoExit".into(),
                "-Command".into(),
                format!("& '{ssh_str}' '{alias}'"),
            ],
        )
    }

    match shell {
        Shell::Direct => direct(ssh, alias),
        Shell::Powershell => match system32(r"WindowsPowerShell\v1.0\powershell.exe") {
            Some(p) => in_powershell(p, ssh, alias),
            None => direct(ssh, alias),
        },
        // PowerShell 7 не установлен — падаем на системный powershell:
        // сессия всё равно откроется в оболочке, как и просили.
        Shell::Pwsh => match pwsh_exe() {
            Some(p) => in_powershell(p, ssh, alias),
            None => session_argv(Shell::Powershell, ssh, alias),
        },
        Shell::Cmd => match system32("cmd.exe") {
            Some(p) => (
                p,
                vec!["/k".into(), format!("\"{}\" {alias}", ssh.display())],
            ),
            None => direct(ssh, alias),
        },
    }
}

/// Открыть терминал с подключением к хосту.
///
/// `shell` — что выбрано в настройках: `direct` | `powershell` | `pwsh` | `cmd`.
#[cfg(windows)]
#[tauri::command(async)]
pub(crate) fn ssh_open(
    alias: String,
    shell: Option<String>,
    profile: Option<String>,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // Данные из IPC проверяем заново, как это делает kill_process с pid:
    // список на фронте мог устареть или быть подменён.
    if !valid_alias(&alias) || !hosts().iter().any(|h| h.alias == alias) {
        return Err(format!("Unknown host: {alias}"));
    }
    let ssh = ssh_exe().ok_or("OpenSSH client not found (System32\\OpenSSH\\ssh.exe)")?;
    let (prog, args) = session_argv(
        Shell::parse(shell.as_deref().unwrap_or("direct")),
        &ssh,
        &alias,
    );

    if let Some(wt) = wt_exe() {
        // --suppressApplicationTitle обязателен: без него заголовок вкладки
        // перезатрут escape-последовательности удалённой оболочки.
        let mut cmd = Command::new(&wt);
        cmd.args(["-w", "0", "new-tab"]);
        // Профиль задаёт оформление вкладки — схему, шрифт, фон. Без него
        // Windows Terminal берёт профиль по умолчанию, и сессия выглядит
        // чужой на фоне обычных вкладок. Имя передаём отдельным аргументом,
        // поэтому пробелы и кириллица в нём безопасны.
        if let Some(p) = profile
            .as_deref()
            .filter(|p| !p.trim().is_empty() && p.len() <= 128 && !p.contains(['\r', '\n', '\0']))
        {
            cmd.arg("-p").arg(p);
        }
        let spawned = cmd
            .arg("--title")
            .arg(&alias)
            .arg("--suppressApplicationTitle")
            .arg(&prog)
            .args(&args)
            .spawn();
        if spawned.is_ok() {
            return Ok(());
        }
    }
    Command::new(&prog)
        .args(&args)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
#[tauri::command(async)]
pub(crate) fn ssh_open(
    _alias: String,
    _shell: Option<String>,
    _profile: Option<String>,
) -> Result<(), String> {
    Err("ssh launch unsupported on this platform".into())
}

/// Есть ли на машине системный OpenSSH — лаунчер объясняет это одной строкой,
/// вместо того чтобы показывать пустой список без причины.
#[tauri::command(async)]
pub(crate) fn ssh_client_present() -> bool {
    #[cfg(windows)]
    {
        ssh_exe().is_some()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/* ============================== ЗАПИСЬ ============================== */

/// Значение директивы: без переводов строк (иначе поле впишет в чужой конфиг
/// произвольные директивы) и без кавычек, которые сломали бы экранирование.
/// U+2028/U+2029 отсекаем заодно — они не `\n`, но текстовым редактором
/// показываются как перенос, а значит вводят в заблуждение.
fn valid_value(s: &str) -> bool {
    !s.contains(['\r', '\n', '"', '\u{2028}', '\u{2029}', '\0']) && s.trim() == s && s.len() <= 255
}

/// Значение с пробелами ssh_config понимает только в кавычках.
fn quoted(s: &str) -> String {
    if s.contains(char::is_whitespace) {
        format!("\"{s}\"")
    } else {
        s.to_string()
    }
}

/// Копия рядом с оригиналом перед любой записью.
fn backup(path: &Path) {
    if path.exists() {
        let _ = std::fs::copy(path, path.with_extension("bak"));
    }
}

/// Дописать блок хоста в конец `~/.ssh/config`.
///
/// Исходные байты файла не трогаются вообще: новый блок просто дописывается
/// в конце тем же переводом строки, каким живёт файл.
#[tauri::command(async)]
pub(crate) fn ssh_add_host(
    alias: String,
    hostname: String,
    user: String,
    port: u16,
    identity: String,
) -> Result<(), String> {
    if !valid_alias(&alias) {
        return Err("Alias must be latin letters, digits, dot, dash or underscore".into());
    }
    if hostname.trim().is_empty()
        || !valid_value(&hostname)
        || hostname.contains(char::is_whitespace)
    {
        return Err("Host name is empty or contains invalid characters".into());
    }
    if !user.is_empty() && (!valid_value(&user) || user.contains(char::is_whitespace)) {
        return Err("User contains invalid characters".into());
    }
    if !identity.is_empty() && !valid_value(&identity) {
        return Err("Key path contains invalid characters".into());
    }
    if port == 0 {
        return Err("Port must be between 1 and 65535".into());
    }
    if hosts().iter().any(|h| h.alias == alias) {
        return Err(format!("Host {alias} already exists"));
    }

    let path = user_config().ok_or("No user profile directory")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Существующий файл, который не читается, — не повод его затирать.
    let existing: Vec<u8> = if path.exists() {
        std::fs::read(&path).map_err(|e| e.to_string())?
    } else {
        Vec::new()
    };
    backup(&path);

    let nl = newline_of(&existing);
    // hostname и user проверены на отсутствие пробелов — кавычки нужны пути.
    let mut block = vec![
        MARKER.to_string(),
        format!("Host {alias}"),
        format!("    HostName {hostname}"),
    ];
    if !user.is_empty() {
        block.push(format!("    User {user}"));
    }
    if port != DEFAULT_PORT {
        block.push(format!("    Port {port}"));
    }
    if !identity.is_empty() {
        block.push(format!("    IdentityFile {}", quoted(&identity)));
    }

    let mut out = existing;
    if !out.is_empty() && !out.ends_with(b"\n") {
        out.extend_from_slice(nl); // файл не заканчивался переводом строки
    }
    out.extend_from_slice(nl); // пустая строка отделяет блок от предыдущего
    for line in block {
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(nl);
    }
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

/// Конец блока — первая строка, которая ему не принадлежит.
///
/// Пустые строки и комментарии блоку НЕ принадлежат: съедать их значило бы
/// уносить с собой заголовок следующего, чужого блока.
fn is_block_body(line: &str) -> bool {
    !line.trim().is_empty() && !is_comment(line) && !is_top_level(line)
}

/// Удалить блок, который добавляла Agora. Чужие блоки не трогаем — на них
/// держится вся остальная работа пользователя.
#[tauri::command(async)]
pub(crate) fn ssh_remove_host(alias: String) -> Result<(), String> {
    if !hosts().iter().any(|h| h.alias == alias && h.managed) {
        return Err(format!("Host {alias} was not added by Agora"));
    }
    let path = user_config().ok_or("No user profile directory")?;
    let raw = read_raw_lines(&path).ok_or("Cannot read ssh config")?;

    let text_of = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    let mut out: Vec<Vec<u8>> = Vec::new();
    let mut i = 0usize;
    let mut removed = false;

    while let Some(line) = raw.get(i) {
        let our_block = !removed
            && is_marker(&text_of(line))
            && raw
                .get(i + 1)
                .map(|n| text_of(n))
                .as_deref()
                .and_then(|n| {
                    split_kv(n)
                        .filter(|(k, _)| k == "host")
                        .map(|(_, v)| host_alias(v).map(str::to_string))
                })
                .flatten()
                .as_deref()
                == Some(alias.as_str());
        if !our_block {
            out.push(line.clone());
            i += 1;
            continue;
        }
        // Пустую строку, которой мы сами отбили блок при добавлении, забираем
        // с собой — иначе цикл добавить/удалить копил бы пустые строки.
        if out.last().is_some_and(|l| text_of(l).trim().is_empty()) {
            out.pop();
        }
        i += 2; // маркер и строка Host
        while raw.get(i).is_some_and(|l| is_block_body(&text_of(l))) {
            i += 1;
        }
        removed = true;
    }
    if !removed {
        return Err(format!("Block for {alias} not found"));
    }
    backup(&path);
    std::fs::write(&path, out.concat()).map_err(|e| e.to_string())
}

/// Приватные ключи из `~/.ssh` — для выбора в форме добавления хоста.
/// Признак ключа — заголовок PEM в первой строке, а не имя файла.
#[tauri::command(async)]
pub(crate) fn ssh_keys() -> Vec<String> {
    let Some(dir) = ssh_dir() else {
        return Vec::new();
    };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().is_file())
        .filter(|e| {
            let p = e.path();
            let ext_ok = p
                .extension()
                .and_then(|x| x.to_str())
                .is_none_or(|x| !matches!(x, "pub" | "bak" | "old"));
            ext_ok && starts_with_pem(&p)
        })
        .filter_map(|e| e.path().to_str().map(str::to_string))
        .collect();
    out.sort();
    out
}

fn starts_with_pem(path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 11];
    f.read_exact(&mut head).is_ok() && head.starts_with(b"-----BEGIN")
}

#[cfg(test)]
mod tests {
    use super::{is_block_body, parse_text, split_kv, valid_alias, valid_value, Item, SshHost};

    fn parse(text: &str) -> Vec<SshHost> {
        parse_text(text)
            .into_iter()
            .filter_map(|i| match i {
                Item::Host(h) => Some(*h),
                Item::Include(_) => None,
            })
            .collect()
    }

    fn includes(text: &str) -> Vec<String> {
        parse_text(text)
            .into_iter()
            .filter_map(|i| match i {
                Item::Include(p) => Some(p),
                Item::Host(_) => None,
            })
            .collect()
    }

    #[test]
    fn reads_plain_block() {
        let h = parse("Host prod\n  HostName example.com\n  User root\n  Port 2222\n");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].alias, "prod");
        assert_eq!(h[0].hostname, "example.com");
        assert_eq!(h[0].user, "root");
        assert_eq!(h[0].port, 2222);
    }

    #[test]
    fn defaults_port() {
        assert_eq!(parse("Host solo\n")[0].port, 22);
    }

    #[test]
    fn skips_wildcard_and_multi_pattern_blocks() {
        let h = parse("Host *\n  User nobody\nHost a b\n  User nobody\nHost real\n");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].alias, "real");
    }

    #[test]
    fn wildcard_directives_do_not_leak_into_next_host() {
        let h = parse("Host *\n  User nobody\nHost real\n  HostName r.example\n");
        assert_eq!(h[0].user, "");
    }

    #[test]
    fn match_block_is_skipped_whole() {
        let h = parse("Host a\nMatch host b\n  User leaked\n");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].user, "");
    }

    #[test]
    fn counts_forwards_and_marks_managed() {
        let h = parse("# agora\nHost t\n  LocalForward 1 l:1\n  LocalForward 2 l:2\n");
        assert_eq!(h[0].forwards, 2);
        assert!(h[0].managed);
    }

    #[test]
    fn marker_binds_only_to_the_next_block() {
        let h = parse("# agora\nHost mine\nHost theirs\n");
        assert!(h[0].managed);
        assert!(!h[1].managed);
    }

    #[test]
    fn marker_does_not_survive_a_directive() {
        // Иначе блок отчитался бы как свой, а удалить его было бы нельзя.
        let h = parse("# agora\nInclude other\nHost theirs\n");
        assert!(!h[0].managed);
    }

    #[test]
    fn accepts_equals_and_quotes() {
        let h = parse("Host q\n  HostName=\"a.example\"\n  IdentityFile \"C:\\k e\\id\"\n");
        assert_eq!(h[0].hostname, "a.example");
        assert_eq!(h[0].identity, "C:\\k e\\id");
    }

    #[test]
    fn first_value_wins_inside_block() {
        let h = parse("Host d\n  HostName first\n  HostName second\n  Port 111\n  Port 222\n");
        assert_eq!(h[0].hostname, "first");
        assert_eq!(h[0].port, 111);
    }

    #[test]
    fn trailing_comment_on_host_line_keeps_the_host() {
        let h = parse("Host prod # production box\n  HostName p.example\n");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].alias, "prod");
    }

    #[test]
    fn bom_does_not_swallow_the_first_host() {
        let h = parse("\u{feff}Host first\n  HostName f.example\n");
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].alias, "first");
    }

    #[test]
    fn crlf_config_parses() {
        let h = parse("Host a\r\n  HostName a.example\r\n  Port 2200\r\n");
        assert_eq!(h[0].hostname, "a.example");
        assert_eq!(h[0].port, 2200);
    }

    #[test]
    fn collects_include_paths_in_order() {
        assert_eq!(
            includes("Include conf.d/*.conf\nHost a\n"),
            vec!["conf.d/*.conf"]
        );
        let items = parse_text("Host a\nInclude x\nHost b\n");
        assert!(matches!(items[1], Item::Include(_))); // между хостами, на своём месте
    }

    #[test]
    fn rejects_dangerous_aliases() {
        assert!(valid_alias("prod-01.eu"));
        assert!(!valid_alias("-oProxyCommand=calc"));
        assert!(!valid_alias("has space"));
        assert!(!valid_alias(""));
    }

    #[test]
    fn rejects_newline_injection_in_values() {
        assert!(valid_value("example.com"));
        assert!(!valid_value("a.com\n  ProxyCommand calc"));
        assert!(!valid_value("has\"quote"));
        assert!(!valid_value("a.com\u{2028}ProxyCommand calc"));
    }

    #[test]
    fn split_kv_handles_both_forms() {
        assert_eq!(split_kv("Port 22"), Some(("port".into(), "22")));
        assert_eq!(split_kv("Port=22"), Some(("port".into(), "22")));
        assert_eq!(split_kv("Port = 22"), Some(("port".into(), "22")));
    }

    #[cfg(windows)]
    #[test]
    fn strips_jsonc_comments_but_not_string_contents() {
        // settings.json Windows Terminal приходит с //-комментариями, а внутри
        // строк «//» — обычные символы (например, в URL или пути).
        let src = "{\n  // top\n  \"name\": \"a // b\", // tail\n  \"x\": 1\n}";
        let out = super::strip_jsonc(src);
        assert!(out.contains("a // b"));
        assert!(!out.contains("top"));
        assert!(!out.contains("tail"));
        assert!(serde_json::from_str::<serde_json::Value>(&out).is_ok());
    }

    #[test]
    fn block_body_stops_at_comments_and_blanks() {
        // Ровно это правило бережёт комментарий над следующим, чужим блоком.
        assert!(is_block_body("    HostName x"));
        assert!(!is_block_body(""));
        assert!(!is_block_body("   "));
        assert!(!is_block_body("# work jump host"));
        assert!(!is_block_body("Host other"));
        assert!(!is_block_body("Include more"));
    }
}
