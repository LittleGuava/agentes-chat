//! `agenteschat://` links (the setup's end, a QR code's link, a teammate's): the welcome window shows them,
//! with the server in large type, and nothing changes before the person confirms there. Rust keeps only the
//! newest link until the window takes it (`link_take`), and passes nothing it didn't check is one of ours.
//! A connector's sign-in that the browser hands back (`agenteschat://desktop/connectors/oauth`) goes to the
//! main window instead, which finishes it with its own session.
//! A pair link (`agenteschat://pair?server=&link=`, the web's "Open the agentes.chat app") goes there too, rebuilt from
//! its two checked fields: the window asks the server who made the link (`pair_link_info`) and pairs this computer
//! only after the person confirms there, and then the link's maker still lets it in on the web (ADR 0066 §3 as amended).
//! A link to a conversation, a DM, a message or a task (`agenteschat://org/<org>/c/<channel>?m=`, the phone's
//! `agenteschat://chat/<channel>`, ADR 0138 addendum of 2026-11-15) brings the main window forward on that page, rebuilt
//! from its checked fields; one for a server the app doesn't open only has the welcome window say so.
//! On macOS a link reaches the running app as an event; on Windows and Linux as a second launch, which the
//! single-instance plugin hands to the deep-link plugin.

use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;

pub const SCHEME: &str = "agenteschat";
/// A connect link is short (a server and a token or a claim); anything longer isn't one.
const MAX_LINK: usize = 2048;
/// A connect link's code: 8 of these, shown as `ABCD-EFGH` (packages/engine machine-device.ts `USER_CODE_ALPHABET`).
const CODE_ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INFO_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct PendingLink(Mutex<Option<String>>);

/// One of ours, of a size a link can be.
pub fn accept(url: &Url) -> bool {
    url.scheme() == SCHEME && url.as_str().len() <= MAX_LINK
}

/// A connector's sign-in that the browser handed back (apps/server connectors.ts `oauth/callback`).
fn is_connector_return(url: &Url) -> bool {
    url.host_str() == Some("desktop") && url.path() == "/connectors/oauth"
}

/// The page of `site` that finishes it (apps/web desktop.connector.tsx), with only its own fields.
pub fn connector_page(url: &Url, site: &Url) -> Option<Url> {
    if !is_connector_return(url) {
        return None;
    }
    let mut page = site.join("/desktop/connector").ok()?;
    page.set_fragment(None);
    page.set_query(None);
    let fields: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| matches!(&**key, "org" | "state" | "code" | "error"))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    page.query_pairs_mut().extend_pairs(fields);
    Some(page)
}

/// A pair link's two fields: the server's origin and the code as the server stores it (`ABCDEFGH`).
#[derive(Debug, PartialEq)]
pub struct PairLink {
    pub server: String,
    pub code: String,
}

/// `ABCD-EFGH` or `abcdefgh` → `ABCDEFGH`; None for anything else.
fn link_code(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let bare = match raw.len() {
        8 => raw.to_string(),
        9 if raw.as_bytes()[4] == b'-' => raw.replacen('-', "", 1),
        _ => return None,
    }
    .to_ascii_uppercase();
    (bare.len() == 8 && bare.chars().all(|c| CODE_ALPHABET.contains(c))).then_some(bare)
}

/// `agenteschat://pair?server=<origin>&link=<code>`: a server the app may open (https, or http on loopback) and a
/// connect link's code. Other fields are ignored; None when it isn't one.
pub fn pair_link(url: &Url) -> Option<PairLink> {
    if url.scheme() != SCHEME || url.host_str() != Some("pair") || !matches!(url.path(), "" | "/") {
        return None;
    }
    let field = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    let server = crate::servers::origin_of(field("server")?.trim())?;
    let code = link_code(&field("link")?)?;
    Some(PairLink { server, code })
}

/// The link the welcome window takes: only its checked fields.
fn pair_url(pair: &PairLink) -> String {
    let mut url = Url::parse("agenteschat://pair").expect("a fixed URL");
    url.query_pairs_mut().append_pair("server", &pair.server).append_pair("link", &pair.code);
    url.to_string()
}

/// A chat link's checked fields (ADR 0138, addendum of 2026-11-15).
#[derive(Debug, PartialEq)]
pub struct ChatLink {
    /// The server it names (`server=`); None: the one open now.
    pub server: Option<String>,
    /// The workspace; None (the phone's `chat/<channel>` naming none): the one the window shows.
    pub org: Option<String>,
    /// The web's page inside the workspace, rebuilt from the checked fields: `/c/<channel>?m=<message>`.
    pub page: String,
}

/// The query fields a page reads, in the order they are written; any other field is left out.
const PAGE_FIELDS: [&str; 3] = ["thread", "tm", "m"];

/// A task's number: what the web's `/issues/<number>` takes.
fn task_number(n: &str) -> bool {
    (1..=9).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit())
}

/// `path` with the fields of `query` that are ids, among `fields`, in `PAGE_FIELDS`' order.
fn with_fields(path: String, query: &[(String, String)], fields: &[&str]) -> String {
    let mut page = path;
    let mut sep = '?';
    for name in PAGE_FIELDS.iter().filter(|f| fields.contains(f)) {
        if let Some((_, value)) = query.iter().find(|(k, _)| k == name) {
            if crate::workspaces::good_id(value) {
                page.push(sep);
                page.push_str(&format!("{name}={value}"));
                sep = '&';
            }
        }
    }
    page
}

/// A link to a conversation, a DM, a message or a task (ADR 0138, addendum of 2026-11-15):
/// - the web's own address under the app's scheme: `agenteschat://org/<org>/c/<channel>` (`?m=`, `?thread=&tm=`),
///   `…/dm/agent/<agent>`, `…/dm/person/<person>` (`?m=`, `?thread=&tm=`), `…/threads/<thread>` and
///   `…/issues/<number>` (`?m=`);
/// - the phone's `agenteschat://chat/<channel>` (`?thread=`, `?m=`, `?org=`).
///
/// Each may name its server (`server=<origin>`, as a pair link does). None when it isn't one, or names a server the
/// app couldn't open.
pub fn chat_link(url: &Url) -> Option<ChatLink> {
    if url.scheme() != SCHEME {
        return None;
    }
    let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let field = |name: &str| query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    let server = match field("server") {
        Some(raw) => Some(crate::servers::origin_of(raw.trim())?),
        None => None,
    };
    let path = url.path().strip_suffix('/').unwrap_or(url.path());
    let parts: Vec<&str> = path.split('/').skip(1).collect();
    let id = |s: &str| crate::workspaces::good_id(s);
    let (org, page) = match (url.host_str()?, parts.as_slice()) {
        ("org", [org, rest @ ..]) if id(org) => {
            let page = match rest {
                ["c", channel] if id(channel) => with_fields(format!("/c/{channel}"), &query, &PAGE_FIELDS),
                ["dm", who @ ("agent" | "person"), other] if id(other) => {
                    with_fields(format!("/dm/{who}/{other}"), &query, &PAGE_FIELDS)
                }
                ["threads", thread] if id(thread) => with_fields(format!("/threads/{thread}"), &query, &["m"]),
                ["issues", number] if task_number(number) => with_fields(format!("/issues/{number}"), &query, &["m"]),
                _ => return None,
            };
            (Some(org.to_string()), page)
        }
        ("chat", [channel]) if id(channel) => {
            // The phone's `m` is the thread's message when a thread is open: the web's panel calls that `tm`.
            let thread = field("thread").filter(|t| id(t));
            let renamed: Vec<(String, String)> = query
                .iter()
                .map(|(k, v)| match (k.as_str(), thread) {
                    ("m", Some(_)) => ("tm".to_string(), v.clone()),
                    ("tm", _) => (String::new(), v.clone()),
                    _ => (k.clone(), v.clone()),
                })
                .collect();
            let org = field("org").filter(|o| id(o)).map(str::to_string);
            (org, with_fields(format!("/c/{channel}"), &renamed, &PAGE_FIELDS))
        }
        _ => return None,
    };
    Some(ChatLink { server, org, page })
}

/// What a chat link does.
#[derive(Debug, PartialEq)]
pub enum ChatOpen {
    /// The window on this page, of a server in the app's list.
    Page(Url),
    /// The link names a server the app doesn't open: the welcome window says so.
    Elsewhere(String),
    /// No server chosen yet (the first run).
    Nowhere,
}

/// Where `link` opens: its server (else the one open now, `current`) when the app has it (`servers`), in its workspace
/// (else the one the window shows there, `shown`: origin and workspace), else that server's first page.
pub fn chat_open(link: &ChatLink, servers: &[String], current: Option<&str>, shown: Option<(&str, &str)>) -> ChatOpen {
    let Some(server) = link.server.as_deref().or(current) else { return ChatOpen::Nowhere };
    if !servers.iter().any(|s| s == server) {
        return ChatOpen::Elsewhere(server.to_string());
    }
    let org = link.org.as_deref().or(shown.filter(|(origin, _)| *origin == server).map(|(_, org)| org));
    let page = match org {
        Some(org) => format!("{server}/org/{org}{}", link.page),
        None => format!("{server}/"),
    };
    page.parse().map_or(ChatOpen::Nowhere, ChatOpen::Page)
}

/// The link the welcome window gets to say a chat link's server isn't one of the app's: only that server.
pub fn elsewhere_link(server: &str) -> String {
    let mut url = Url::parse("agenteschat://chat").expect("a fixed URL");
    url.query_pairs_mut().append_pair("server", server);
    url.to_string()
}

/// The server and workspace of a page the window shows (`/org/<id>/…`).
pub fn shown_org(page: &Url) -> Option<(String, String)> {
    let mut parts = page.path_segments()?;
    let org = (parts.next() == Some("org")).then(|| parts.next()).flatten()?;
    crate::workspaces::good_id(org).then(|| (page.origin().ascii_serialization(), org.to_string()))
}

/// A chat link: the main window comes to the front on its page (the server switched when the link names another of
/// the app's). A server the app doesn't open, or one it can't show, goes to the welcome window, which says so.
fn open_chat(app: &AppHandle, link: &ChatLink) {
    let servers = crate::servers::get(app).servers;
    let current = crate::main_window::site(app).map(|s| s.origin().ascii_serialization());
    let shown = crate::main_window::page_url(app).and_then(|u| shown_org(&u));
    let shown = shown.as_ref().map(|(origin, org)| (origin.as_str(), org.as_str()));
    match chat_open(link, &servers, current.as_deref(), shown) {
        ChatOpen::Page(page) => {
            // The server here's loopback pages open at its address for people, which must be in the list too.
            let page = crate::local_server::page_for_people(app, page);
            let server = page.origin().ascii_serialization();
            if !servers.contains(&server) {
                return to_welcome(app, elsewhere_link(&server));
            }
            let _ = crate::main_window::show_url(app, page);
        }
        ChatOpen::Elsewhere(server) => to_welcome(app, elsewhere_link(&server)),
        ChatOpen::Nowhere => {
            let _ = crate::present(app, "welcome");
        }
    }
}

/// The welcome window shows `link` (only links this file built or checked).
fn to_welcome(app: &AppHandle, link: String) {
    *app.state::<PendingLink>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(link);
    let _ = crate::present(app, "welcome");
    let _ = app.emit_to("welcome", "link://pending", ());
}

fn receive(app: &AppHandle, urls: Vec<Url>) {
    let Some(url) = urls.into_iter().find(accept) else { return };
    // On the server open now, where the window is signed in: its state is that person's there.
    if is_connector_return(&url) {
        if let Some(page) = crate::main_window::site(app).and_then(|site| connector_page(&url, &site)) {
            let app = app.clone();
            // Not from inside the link's event: the window may have to be made first.
            std::thread::spawn(move || {
                let _ = crate::main_window::show_url(&app, page);
            });
        }
        return;
    }
    if matches!(url.host_str(), Some("org" | "chat")) {
        let Some(link) = chat_link(&url) else {
            // Never handed over as it came: the welcome window reads a server from `chat` links (`elsewhere_link`).
            return to_welcome(app, "agenteschat://chat".into());
        };
        let app = app.clone();
        // Not from inside the link's event: the window may have to be made first.
        std::thread::spawn(move || open_chat(&app, &link));
        return;
    }
    let pending = if url.host_str() == Some("pair") {
        // ponytail: a server on this computer is left out by its address only; one reached here at another address
        // (`discover::served_here`) would pair a second time, after its maker lets it in.
        match pair_link(&url) {
            Some(pair)
                if crate::main_window::agents_here(&pair.server, crate::local_server::is_here(app, &pair.server)) =>
            {
                pair_url(&pair)
            }
            _ => return,
        }
    } else {
        url.to_string()
    };
    to_welcome(app, pending);
}

/// Listens for links, takes the one the app was opened with, and (Linux, where an AppImage has no
/// `.desktop` file of its own) registers the scheme.
pub fn setup(app: &AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| receive(&handle, event.urls()));
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        receive(app, urls);
    }
    #[cfg(target_os = "linux")]
    let _ = app.deep_link().register_all();
}

/// A second launch carrying a link (Windows, Linux): the link is handled, the main window stays as it is.
pub fn in_args(args: &[String]) -> bool {
    args.iter().any(|a| a.starts_with("agenteschat:"))
}

#[tauri::command]
pub fn link_take(app: AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    if window.label() != "welcome" {
        return Err("only the welcome window takes links".into());
    }
    Ok(app.state::<PendingLink>().0.lock().unwrap_or_else(|e| e.into_inner()).take())
}

/// What the server says about a live connect link (`GET /api/machines/connect-links/{code}`, no session).
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub org: String,
    pub by: String,
    pub kind: String,
    pub expires_at: String,
    /// This computer's own name, for "This Mac: …"; None when the system doesn't say.
    pub computer: Option<String>,
}

/// A name from the server, shown as is: trimmed, at most 80 characters, no control characters.
fn shown_name(value: &Value) -> Option<String> {
    let name: String = value.as_str()?.trim().chars().take(80).collect();
    (!name.is_empty() && !name.chars().any(char::is_control)).then_some(name)
}

/// The server's answer: the link's workspace and maker, or `link_expired` (unknown, used or expired: one answer).
pub fn read_link_info(status: u16, body: &str) -> Result<LinkInfo, String> {
    if status == 404 {
        return Err("link_expired".into());
    }
    if status != 200 {
        return Err("unreachable".into());
    }
    let v: Value = serde_json::from_str(body).map_err(|_| "unreachable")?;
    let kind = v["kind"].as_str().filter(|k| matches!(*k, "computer" | "server")).ok_or("unreachable")?;
    Ok(LinkInfo {
        org: shown_name(&v["org"]["name"]).ok_or("unreachable")?,
        by: shown_name(&v["by"]["name"]).ok_or("unreachable")?,
        kind: kind.to_string(),
        expires_at: v["expiresAt"].as_str().filter(|t| t.len() <= 40).unwrap_or_default().to_string(),
        computer: None,
    })
}

/// This computer's name as people see it: the Mac's own, else the system's host name.
fn computer_name() -> Option<String> {
    crate::host_sync::computer_name()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty() && n.chars().count() <= 64)
}

/// The welcome window's pair link: who made it and for which workspace, asked of its server over plain HTTPS
/// (no cookies: the link is the only thing it knows). `link_expired`, or `unreachable`.
#[tauri::command]
pub async fn pair_link_info(window: tauri::Window, server: String, code: String) -> Result<LinkInfo, String> {
    if window.label() != "welcome" {
        return Err("only the welcome window asks this".into());
    }
    let pair = Url::parse(&pair_url(&PairLink { server, code })).ok().and_then(|u| pair_link(&u)).ok_or("bad link")?;
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout(INFO_TIMEOUT).redirects(0).build();
        let url = format!("{}/api/machines/connect-links/{}", pair.server, pair.code);
        let response = match agent.get(&url).set("Accept", "application/json").call() {
            Ok(r) | Err(ureq::Error::Status(_, r)) => r,
            Err(_) => return Err("unreachable".to_string()),
        };
        let status = response.status();
        let mut body = String::new();
        let _ = response.into_reader().take(64 * 1024).read_to_string(&mut body);
        read_link_info(status, &body).map(|info| LinkInfo { computer: computer_name(), ..info })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_links() {
        let ok: Url = "agenteschat://connect?server=https%3A%2F%2Fagentes.tail1234.ts.net".parse().unwrap();
        assert!(accept(&ok));
        assert!(!accept(&"https://app.agentes.chat/connect".parse().unwrap()));
        let long: Url = format!("agenteschat://connect?server=x&pad={}", "a".repeat(MAX_LINK)).parse().unwrap();
        assert!(!accept(&long));
        assert!(in_args(&["/usr/bin/agentes".into(), "agenteschat://connect?server=x".into()]));
        assert!(!in_args(&["/usr/bin/agentes".into(), "--autostart".into()]));
    }

    #[test]
    fn pair_links() {
        let pair = |u: &str| pair_link(&u.parse().unwrap());
        let ok = Some(PairLink { server: "https://app.agentes.chat".into(), code: "ABCDEFGH".into() });
        assert_eq!(pair("agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFGH"), ok);
        assert_eq!(pair("agenteschat://pair/?link=abcdefgh&server=https://app.agentes.chat/&utm=x"), ok);
        assert_eq!(
            pair("agenteschat://pair?server=http%3A%2F%2F127.0.0.1%3A4310&link=ABCD-EFGH").map(|p| p.server),
            Some("http://127.0.0.1:4310".into())
        );
        for bad in [
            "agenteschat://pair?server=http%3A%2F%2Fagentes.example.com&link=ABCD-EFGH",
            "agenteschat://pair?server=https%3A%2F%2Fu%3Ap%40agentes.example.com&link=ABCD-EFGH",
            "agenteschat://pair?server=agentes.example.com&link=ABCD-EFGH",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFG",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFGHJ",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABC-DEFGH",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFG1",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-ÉFGH",
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat",
            "agenteschat://pair?link=ABCD-EFGH",
            "agenteschat://pair/x?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFGH",
            "agenteschat://connect?server=https%3A%2F%2Fapp.agentes.chat&link=ABCD-EFGH",
        ] {
            assert_eq!(pair(bad), None, "{bad}");
        }
        // The window gets only the two fields, as the server stores the code.
        assert_eq!(
            pair_url(&PairLink { server: "https://app.agentes.chat".into(), code: "ABCDEFGH".into() }),
            "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCDEFGH"
        );
    }

    const O: &str = "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const C: &str = "0193a1b2-0000-7e5f-8a9b-0c1d2e3f4a5c";
    const M: &str = "0193a1b2-1111-7e5f-8a9b-0c1d2e3f4a5d";

    fn chat(u: &str) -> Option<ChatLink> {
        chat_link(&u.parse().unwrap())
    }

    fn page(u: &str) -> Option<String> {
        chat(u).map(|l| l.page)
    }

    #[test]
    fn chat_links_are_the_web_s_pages() {
        // The web's address under the app's scheme: a channel, a DM, a thread's reply, a task, at a message.
        assert_eq!(
            chat(&format!("agenteschat://org/{O}/c/{C}?m={M}")),
            Some(ChatLink { server: None, org: Some(O.into()), page: format!("/c/{C}?m={M}") })
        );
        assert_eq!(page(&format!("agenteschat://org/{O}/c/{C}/")), Some(format!("/c/{C}")));
        assert_eq!(page(&format!("agenteschat://org/{O}/dm/agent/{C}?m={M}")), Some(format!("/dm/agent/{C}?m={M}")));
        assert_eq!(page(&format!("agenteschat://org/{O}/dm/person/{C}")), Some(format!("/dm/person/{C}")));
        assert_eq!(page(&format!("agenteschat://org/{O}/threads/{C}?m={M}")), Some(format!("/threads/{C}?m={M}")));
        assert_eq!(page(&format!("agenteschat://org/{O}/issues/42?m={M}")), Some(format!("/issues/42?m={M}")));
        // A thread open in the conversation's panel; only the fields the page reads, in one order.
        assert_eq!(
            page(&format!("agenteschat://org/{O}/c/{C}?tm={M}&reply=true&thread={M}&adjust=x&paid=1")),
            Some(format!("/c/{C}?thread={M}&tm={M}"))
        );
        // A field that isn't an id is left out, as the phone does; the thread panel isn't a thread page's.
        assert_eq!(page(&format!("agenteschat://org/{O}/c/{C}?m=%3Cscript%3E")), Some(format!("/c/{C}")));
        assert_eq!(page(&format!("agenteschat://org/{O}/threads/{C}?thread={M}")), Some(format!("/threads/{C}")));
        // The server it names, as the app keeps it.
        assert_eq!(
            chat(&format!("agenteschat://org/{O}/c/{C}?server=https%3A%2F%2Fapp.agentes.chat%2F")).map(|l| l.server),
            Some(Some("https://app.agentes.chat".into()))
        );
        for bad in [
            format!("agenteschat://org/{O}/c/{C}?server=http%3A%2F%2Fagentes.example.com"),
            format!("agenteschat://org/{O}/c/{C}?server=agentes.example.com"),
            format!("agenteschat://org/{O}/c"),
            format!("agenteschat://org/{O}/c/{C}/x"),
            format!("agenteschat://org/{O}/c/%3Cscript%3E"),
            format!("agenteschat://org/{O}/c/.."),
            format!("agenteschat://org/{O}/c/{}", "a".repeat(65)),
            format!("agenteschat://org/{O}/dm/bot/{C}"),
            format!("agenteschat://org/{O}/dm/agent"),
            format!("agenteschat://org/{O}/issues/x1"),
            format!("agenteschat://org/{O}/issues/1234567890"),
            format!("agenteschat://org/{O}/settings/members"),
            format!("agenteschat://org/{O}"),
            format!("agenteschat://org/x%2Fy/c/{C}"),
            format!("agenteschat://pair/{O}/c/{C}"),
            format!("https://app.agentes.chat/org/{O}/c/{C}"),
        ] {
            assert_eq!(chat(&bad), None, "{bad}");
        }
    }

    #[test]
    fn the_phone_s_chat_links() {
        // `chat/<channel>?thread=` as the phone takes it, in the workspace the window shows unless `org=` names one.
        assert_eq!(
            chat(&format!("agenteschat://chat/{C}")),
            Some(ChatLink { server: None, org: None, page: format!("/c/{C}") })
        );
        assert_eq!(page(&format!("agenteschat://chat/{C}?m={M}")), Some(format!("/c/{C}?m={M}")));
        assert_eq!(
            page(&format!("agenteschat://chat/{C}?thread={M}&m={C}")),
            Some(format!("/c/{C}?thread={M}&tm={C}"))
        );
        assert_eq!(page(&format!("agenteschat://chat/{C}/?thread=<script>")), Some(format!("/c/{C}")));
        assert_eq!(chat(&format!("agenteschat://chat/{C}?org={O}")).and_then(|l| l.org), Some(O.into()));
        assert_eq!(chat(&format!("agenteschat://chat/{C}?org=..")).map(|l| l.org), Some(None));
        for bad in
            ["agenteschat://chat", "agenteschat://chat/", "agenteschat://chat/a/b", "agenteschat://chat?server=x"]
        {
            assert_eq!(chat(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_chat_link_opens_on_its_server_or_says_it_can_t() {
        let cloud = "https://app.agentes.chat";
        let own = "https://agentes.example.com";
        let servers = vec![cloud.to_string(), own.to_string()];
        let open = |u: &str, current: Option<&str>, shown: Option<(&str, &str)>| {
            chat_open(&chat(u).unwrap(), &servers, current, shown)
        };
        let at = |u: String| ChatOpen::Page(u.parse().unwrap());
        // On the server open now, or the one the link names when the app has it: the window moves there.
        assert_eq!(
            open(&format!("agenteschat://org/{O}/c/{C}?m={M}"), Some(cloud), None),
            at(format!("{cloud}/org/{O}/c/{C}?m={M}"))
        );
        let elsewhere = format!("agenteschat://org/{O}/issues/7?server=https%3A%2F%2Fagentes.example.com");
        assert_eq!(open(&elsewhere, Some(cloud), None), at(format!("{own}/org/{O}/issues/7")));
        // A server the app doesn't open: said, never added.
        let unknown = format!("agenteschat://org/{O}/c/{C}?server=https%3A%2F%2Fother.example.com");
        assert_eq!(open(&unknown, Some(cloud), None), ChatOpen::Elsewhere("https://other.example.com".into()));
        assert_eq!(open(&format!("agenteschat://org/{O}/c/{C}"), None, None), ChatOpen::Nowhere);
        // The phone's link: the workspace the window shows on that same server, else only the window comes.
        let phone = format!("agenteschat://chat/{C}");
        assert_eq!(open(&phone, Some(cloud), Some((cloud, O))), at(format!("{cloud}/org/{O}/c/{C}")));
        assert_eq!(open(&phone, Some(cloud), None), at(format!("{cloud}/")));
        let named = format!("agenteschat://chat/{C}?server=https%3A%2F%2Fagentes.example.com");
        assert_eq!(open(&named, Some(cloud), Some((cloud, O))), at(format!("{own}/")));
        assert_eq!(
            open(&format!("{phone}?org={M}"), Some(cloud), Some((cloud, O))),
            at(format!("{cloud}/org/{M}/c/{C}"))
        );
        // What the welcome window is handed to say so: only the server, rebuilt.
        assert_eq!(
            elsewhere_link("https://other.example.com"),
            "agenteschat://chat?server=https%3A%2F%2Fother.example.com"
        );
    }

    #[test]
    fn the_window_s_workspace() {
        let shown = |u: &str| shown_org(&u.parse().unwrap());
        assert_eq!(
            shown(&format!("https://app.agentes.chat/org/{O}/c/{C}?m={M}")),
            Some(("https://app.agentes.chat".into(), O.into()))
        );
        assert_eq!(shown(&format!("http://127.0.0.1:4310/org/{O}")), Some(("http://127.0.0.1:4310".into(), O.into())));
        assert_eq!(shown("https://app.agentes.chat/login"), None);
        assert_eq!(shown("https://app.agentes.chat/org/%3Cx%3E/c"), None);
    }

    #[test]
    fn link_info() {
        let live = r#"{ "org": { "name": " Acme " }, "by": { "name": "Sam Rivera" }, "kind": "computer", "expiresAt": "2026-11-09T12:10:00.000Z" }"#;
        assert_eq!(
            read_link_info(200, live),
            Ok(LinkInfo {
                org: "Acme".into(),
                by: "Sam Rivera".into(),
                kind: "computer".into(),
                expires_at: "2026-11-09T12:10:00.000Z".into(),
                computer: None,
            })
        );
        assert_eq!(read_link_info(404, r#"{ "error": "link_expired" }"#), Err("link_expired".into()));
        assert_eq!(read_link_info(429, ""), Err("unreachable".into()));
        assert_eq!(read_link_info(200, "<html>"), Err("unreachable".into()));
        assert_eq!(read_link_info(200, &live.replace("computer", "phone")), Err("unreachable".into()));
        assert_eq!(read_link_info(200, &live.replace("Sam Rivera", "")), Err("unreachable".into()));
    }

    #[test]
    fn a_connector_s_sign_in_goes_to_the_site_open_now() {
        let site: Url = "https://app.agentes.chat".parse().unwrap();
        let back: Url = "agenteschat://desktop/connectors/oauth?org=o1&state=s1&code=c%202&other=x".parse().unwrap();
        assert_eq!(
            connector_page(&back, &site).unwrap().as_str(),
            "https://app.agentes.chat/desktop/connector?org=o1&state=s1&code=c+2"
        );
        let refused: Url = "agenteschat://desktop/connectors/oauth?org=o1&error=access_denied".parse().unwrap();
        assert_eq!(
            connector_page(&refused, &site).unwrap().as_str(),
            "https://app.agentes.chat/desktop/connector?org=o1&error=access_denied"
        );
        // A server of the person's own, on its own port; the phone app's link and a connect link aren't this.
        let own: Url = "http://127.0.0.1:4310/".parse().unwrap();
        assert!(connector_page(&back, &own).unwrap().as_str().starts_with("http://127.0.0.1:4310/desktop/connector?"));
        assert!(connector_page(&"agenteschat://connectors/oauth?state=s&code=c".parse().unwrap(), &site).is_none());
        assert!(connector_page(&"agenteschat://connect?server=x".parse().unwrap(), &site).is_none());
    }
}
