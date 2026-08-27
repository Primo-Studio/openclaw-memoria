//! Lanceur bureau Memoria (spec §14, voie « non-dev », v1 pragmatique).
//!
//! Miroir Rust de `packages/daemon/src/client.ts#ensureDaemon` et de
//! `packages/core/src/config.ts#resolveStorageRoot` :
//!  1. trouver un Node ≥ 20 sur la machine (pas de Node embarqué en v1 — v1.5) ;
//!  2. démarrer `packages/daemon/dist/bin.js` détaché s'il ne tourne pas ;
//!  3. lire `<storage_root>/daemon.json` (port + admin_token, chmod 600) ;
//!  4. donner à la page de lancement l'URL `http://127.0.0.1:<port>/ui/#token=…`.
//!
//! Les 4 commandes Tauri (`check_node`, `daemon_health`, `start_daemon`,
//! `open_memoria`) sont déclarées `async` : Tauri exécute les commandes sync
//! sur le thread principal, et celles-ci font de l'IO bloquante (process,
//! réseau local) — on les bascule donc sur le pool bloquant du runtime.

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Modèles (miroirs des structures TS)
// ---------------------------------------------------------------------------

/// `~/.memoria/config.toml` — même fichier de découverte que `core/config.ts`.
/// Les clés inconnues (llm, …) sont ignorées par serde : pas de couplage.
#[derive(Debug, Default, Deserialize)]
struct ConfigToml {
    /// Racine du stockage (priorité 2 de la résolution).
    storage_path: Option<String>,
    daemon: Option<DaemonSection>,
}

#[derive(Debug, Default, Deserialize)]
struct DaemonSection {
    /// Chemin explicite du `bin.js` du daemon (clé propre au lanceur bureau,
    /// inconnue de core — ignorée par lui, sans risque).
    bin: Option<String>,
}

/// `<storage_root>/daemon.json` — écrit par le daemon (cf. daemon/src/state.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct DaemonState {
    daemon_id: String,
    port: u16,
    admin_token: String,
    pid: i64,
    started_at: String,
}

/// Réponse de `check_node` vers la page de lancement.
#[derive(Debug, Serialize)]
struct NodeInfo {
    path: String,
    version: String,
    major: u32,
}

/// Réponse de `daemon_health`/`start_daemon`. Volontairement SANS le token :
/// seul `open_memoria` construit l'URL finale (surface minimale côté front).
#[derive(Debug, Serialize)]
struct DaemonInfo {
    port: u16,
    healthy: bool,
}

// ---------------------------------------------------------------------------
// Résolution des chemins (miroir de core/config.ts)
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "HOME introuvable — environnement inhabituel".to_string())
}

fn config_path(home: &Path) -> PathBuf {
    home.join(".memoria").join("config.toml")
}

/// Charge `~/.memoria/config.toml`. Fichier absent = config vide (comme core) ;
/// fichier illisible = erreur remontée (jamais avalée).
fn load_config(path: &Path) -> Result<ConfigToml, String> {
    if !path.exists() {
        return Ok(ConfigToml::default());
    }
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("config.toml illisible ({}) : {e}", path.display()))?;
    toml::from_str(&raw).map_err(|e| format!("config.toml invalide ({}) : {e}", path.display()))
}

/// LE résolveur d'emplacement, identique à `resolveStorageRoot()` côté TS :
/// `config.toml#storage_path` > `$MEMORIA_HOME` > `~/.memoria/data`.
/// (Pas de param explicite ici : le lanceur n'en a pas l'usage.)
/// NB : `storage_path` doit être absolu — le cwd d'une app GUI macOS est `/`.
fn resolve_storage_root() -> Result<PathBuf, String> {
    let home = home_dir()?;
    let config = load_config(&config_path(&home))?;
    if let Some(p) = config.storage_path {
        return Ok(PathBuf::from(p));
    }
    if let Some(p) = env::var_os("MEMORIA_HOME") {
        return Ok(PathBuf::from(p));
    }
    Ok(home.join(".memoria").join("data"))
}

/// Lit `<root>/daemon.json`. Absent = None ; JSON corrompu = None + trace
/// stderr (même tolérance que `readDaemonState` TS, mais jamais silencieux).
fn read_daemon_state(storage_root: &Path) -> Option<DaemonState> {
    let p = storage_root.join("daemon.json");
    if !p.exists() {
        return None;
    }
    let raw = match fs::read_to_string(&p) {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!("memoria-desktop: daemon.json illisible ({}) : {e}", p.display());
            return None;
        }
    };
    match serde_json::from_str::<DaemonState>(&raw) {
        Ok(state) => Some(state),
        Err(e) => {
            eprintln!("memoria-desktop: daemon.json corrompu ({}) : {e}", p.display());
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Santé du daemon — GET /v1/health en HTTP/1.1 brut sur 127.0.0.1
// (pas de client HTTP en dépendance pour un ping localhost ; timeouts 2 s,
// même budget que `DaemonClient.health()` TS). Toute défaillance réseau
// signifie « daemon pas joignable », pas une erreur à remonter.
// ---------------------------------------------------------------------------

fn http_health(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    if stream.set_read_timeout(Some(Duration::from_secs(2))).is_err()
        || stream.set_write_timeout(Some(Duration::from_secs(2))).is_err()
    {
        return false;
    }
    let req = b"GET /v1/health HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n";
    if stream.write_all(req).is_err() {
        return false;
    }
    let mut buf = String::new();
    // `connection: close` → le serveur ferme, read_to_string borne la lecture.
    if stream.read_to_string(&mut buf).is_err() {
        return false;
    }
    is_healthy_response(&buf)
}

/// Statut 200 + corps `{"ok":true,…}` (cf. route GET /v1/health du daemon).
fn is_healthy_response(raw: &str) -> bool {
    raw.starts_with("HTTP/1.1 200") && raw.contains("\"ok\":true")
}

// ---------------------------------------------------------------------------
// Découverte de Node ≥ 20 (les apps GUI macOS héritent d'un PATH réduit
// `/usr/bin:/bin:…` — on sonde donc explicitement les emplacements usuels)
// ---------------------------------------------------------------------------

const NODE_MAJOR_MIN: u32 = 20;

/// Extrait le major depuis la sortie de `node --version` (« v22.1.0 » → 22).
fn parse_node_major(version: &str) -> Option<u32> {
    version.trim().strip_prefix('v')?.split('.').next()?.parse().ok()
}

/// `node --version` sur un binaire candidat. Échec d'exécution = candidat
/// suivant (pas une erreur : on sonde des chemins qui peuvent ne pas exister).
fn node_version(path: &Path) -> Option<(String, u32)> {
    let out = Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let major = parse_node_major(&version)?;
    Some((version, major))
}

/// Candidats, du plus prioritaire au moins : override env, PATH, Homebrew
/// (Apple Silicon puis Intel), système, MacPorts, volta, asdf, nvm (plus
/// haute version installée).
fn node_candidates() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Some(p) = env::var_os("MEMORIA_NODE") {
        v.push(PathBuf::from(p));
    }
    v.push(PathBuf::from("node")); // résolution PATH (souvent réduite en GUI)
    for p in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/opt/local/bin/node",
    ] {
        v.push(PathBuf::from(p));
    }
    if let Ok(home) = home_dir() {
        v.push(home.join(".volta").join("bin").join("node"));
        v.push(home.join(".asdf").join("shims").join("node"));
        if let Some(p) = best_nvm_node(&home.join(".nvm").join("versions").join("node")) {
            v.push(p);
        }
    }
    v
}

/// Parcourt `~/.nvm/versions/node/v*/bin/node` et retient le major le plus haut.
fn best_nvm_node(versions_dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(versions_dir).ok()?;
    let mut best: Option<(u32, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(major) = parse_node_major(&name) else { continue };
        let candidate = entry.path().join("bin").join("node");
        if best.as_ref().is_none_or(|(m, _)| major > *m) {
            best = Some((major, candidate));
        }
    }
    best.map(|(_, p)| p)
}

fn find_node() -> Result<NodeInfo, String> {
    for cand in node_candidates() {
        // « node » nu = résolution PATH ; les chemins absolus doivent exister.
        if cand.is_absolute() && !cand.exists() {
            continue;
        }
        if let Some((version, major)) = node_version(&cand) {
            if major >= NODE_MAJOR_MIN {
                return Ok(NodeInfo {
                    path: cand.to_string_lossy().into_owned(),
                    version,
                    major,
                });
            }
        }
    }
    Err(format!(
        "Node.js ≥ {NODE_MAJOR_MIN} introuvable sur cette machine. Installe-le \
         (https://nodejs.org ou `brew install node`) puis relance Memoria. \
         Tu peux aussi pointer un binaire précis via la variable MEMORIA_NODE."
    ))
}

// ---------------------------------------------------------------------------
// Localisation puis démarrage détaché du daemon
// ---------------------------------------------------------------------------

/// Localise `bin.js` du daemon : `$MEMORIA_DAEMON_BIN` > `config.toml
/// [daemon].bin` > installation gérée `~/.memoria/daemon/bin.js` (v1.5) >
/// monorepo du build (dev : CARGO_MANIFEST_DIR = apps/desktop/src-tauri).
fn find_daemon_bin(config: &ConfigToml) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = env::var_os("MEMORIA_DAEMON_BIN") {
        candidates.push(PathBuf::from(p));
    }
    if let Some(bin) = config.daemon.as_ref().and_then(|d| d.bin.as_ref()) {
        candidates.push(PathBuf::from(bin));
    }
    if let Ok(home) = home_dir() {
        candidates.push(home.join(".memoria").join("daemon").join("bin.js"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/daemon/dist/bin.js"),
    );

    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(format!(
        "daemon Memoria introuvable (cherché : {}). Construis le monorepo \
         (`npm run build`) ou renseigne [daemon].bin dans ~/.memoria/config.toml.",
        candidates
            .iter()
            .map(|c| c.display().to_string())
            .collect::<Vec<_>>()
            .join(" · ")
    ))
}

/// Démarre `node bin.js` détaché (nouveau groupe de process : survit à la
/// fermeture de l'app), stdout/stderr vers `~/.memoria/desktop-daemon.log`
/// (le `stdio: 'ignore'` du client TS rendait le diagnostic impossible).
fn spawn_daemon(node: &NodeInfo, bin: &Path) -> Result<PathBuf, String> {
    let home = home_dir()?;
    let log_path = home.join(".memoria").join("desktop-daemon.log");
    if let Some(dir) = log_path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("mkdir {} : {e}", dir.display()))?;
    }
    let log = fs::File::options()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("ouverture du log {} : {e}", log_path.display()))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("dup du log {} : {e}", log_path.display()))?;

    let mut cmd = Command::new(&node.path);
    cmd.arg(bin)
        .current_dir(&home) // cwd stable (une app GUI démarre sur « / »)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // détachement : le daemon survit à l'app
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    cmd.spawn()
        .map_err(|e| format!("impossible de lancer `{} {}` : {e}", node.path, bin.display()))?;
    Ok(log_path)
}

/// Cœur de `start_daemon` : réutilise un daemon vivant, sinon spawn + attente
/// de `daemon.json` + health (budget 15 s, mêmes constantes qu'`ensureDaemon`).
fn start_daemon_blocking() -> Result<DaemonInfo, String> {
    let storage_root = resolve_storage_root()?;
    if let Some(state) = read_daemon_state(&storage_root) {
        if http_health(state.port) {
            return Ok(DaemonInfo { port: state.port, healthy: true });
        }
    }

    // Service launchd (`memoria autostart on`) installé pour CE stockage :
    // c'est LUI qui doit lancer le daemon. Spawner ici prendrait daemon.lock et
    // ferait boucler launchd en échec ; et après un arrêt propre, launchd ne
    // relance pas seul (KeepAlive.SuccessfulExit=false) → kickstart explicite.
    #[cfg(target_os = "macos")]
    if let Some(label) = launchd_service_for(&storage_root) {
        if launchd_kickstart(&label) {
            if let Some(info) = wait_for_health(&storage_root, Duration::from_secs(15)) {
                return Ok(info);
            }
            eprintln!("[memoria-desktop] launchd n'a pas relancé le daemon à temps — démarrage direct en repli");
        }
    }

    let node = find_node()?;
    let home = home_dir()?;
    let config = load_config(&config_path(&home))?;
    let bin = find_daemon_bin(&config)?;
    let log_path = spawn_daemon(&node, &bin)?;

    wait_for_health(&storage_root, Duration::from_secs(15)).ok_or_else(|| {
        format!(
            "le daemon n'a pas démarré dans les 15 s — voir {}",
            log_path.display()
        )
    })
}

/// Attend qu'un daemon réponde au health pour ce stockage (None = délai dépassé).
fn wait_for_health(storage_root: &Path, timeout: Duration) -> Option<DaemonInfo> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
        if let Some(state) = read_daemon_state(storage_root) {
            if http_health(state.port) {
                return Some(DaemonInfo { port: state.port, healthy: true });
            }
        }
    }
    None
}

/// Racine de stockage visée par un plist launchd (argument `--storage-root`),
/// désechappée. Pure : testable sans launchd.
fn storage_root_from_plist(xml: &str) -> Option<String> {
    let marker = "<string>--storage-root</string>";
    let rest = &xml[xml.find(marker)? + marker.len()..];
    let start = rest.find("<string>")? + "<string>".len();
    let end = rest[start..].find("</string>")? + start;
    Some(
        rest[start..end]
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&"),
    )
}

/// UID courant pour le domaine launchd `gui/<uid>` (via `id -u`, sans crate libc).
#[cfg(target_os = "macos")]
fn current_uid() -> String {
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "501".to_string())
}

/// Cible launchd (`gui/<uid>/fr.primo-studio.memoria`) si le service est
/// installé, CHARGÉ, et vise ce stockage. Sinon None → démarrage direct.
#[cfg(target_os = "macos")]
fn launchd_service_for(storage_root: &Path) -> Option<String> {
    let home = home_dir().ok()?;
    let plist = home
        .join("Library")
        .join("LaunchAgents")
        .join("fr.primo-studio.memoria.plist");
    let xml = fs::read_to_string(plist).ok()?;
    let target = storage_root_from_plist(&xml)?;
    if Path::new(&target) != storage_root {
        return None;
    }
    let label = format!("gui/{}/fr.primo-studio.memoria", current_uid());
    let loaded = Command::new("launchctl")
        .args(["print", &label])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    loaded.then_some(label)
}

/// `launchctl kickstart` : lance le service maintenant (no-op s'il tourne).
#[cfg(target_os = "macos")]
fn launchd_kickstart(label: &str) -> bool {
    Command::new("launchctl")
        .args(["kickstart", label])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// URL finale de l'UI : token admin en fragment (#…), jamais en query — le
/// fragment n'est pas envoyé au serveur, donc jamais dans les logs HTTP. Seule
/// la webview de l'app charge cette URL (jamais le navigateur externe, qui la
/// conserverait dans son historique, fragment compris). `admin_token` est du
/// base64url (cf. core/util.ts#newToken) : sûr tel quel dans un fragment.
fn memoria_url(port: u16, admin_token: &str) -> String {
    format!("http://127.0.0.1:{port}/ui/#token={admin_token}")
}

/// Page de lancement embarquée (`frontendDist`) telle que Tauri la sert :
/// `tauri://localhost` sur macOS/Linux, `http://tauri.localhost` sur Windows
/// (cf. tauri `manager::tauri_protocol_url`, non public).
fn launch_page_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    }
}

/// Où envoyer la webview quand on clique « Ouvrir Memoria » (`None` = rester
/// où elle est). Daemon sain (`Some((port, token))`) → son UI, sauf si elle y
/// est déjà (on ne recharge pas : l'utilisateur garde son état). Daemon
/// éteint → la page de lancement, qui montre la séquence Node → daemon → UI
/// et relance le daemon : le clic a toujours un effet visible, jamais un no-op.
fn open_target(current_url: &str, healthy: Option<(u16, &str)>) -> Option<String> {
    match healthy {
        Some((port, token)) => {
            let ui_prefix = format!("http://127.0.0.1:{port}/ui");
            (!current_url.starts_with(&ui_prefix)).then(|| memoria_url(port, token))
        }
        None => {
            let launch = launch_page_url();
            let launch_origin = &launch[..launch.rfind('/').unwrap_or(launch.len())];
            (!current_url.starts_with(launch_origin)).then(|| launch.to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Commandes Tauri (invoquées par ui/index.html)
// ---------------------------------------------------------------------------

/// Joint le pool bloquant et aplatit les deux niveaux d'erreur en message front.
async fn on_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("tâche du lanceur interrompue : {e}"))?
}

#[tauri::command]
async fn check_node() -> Result<NodeInfo, String> {
    on_blocking(find_node).await
}

#[tauri::command]
async fn daemon_health() -> Result<Option<DaemonInfo>, String> {
    on_blocking(|| {
        let storage_root = resolve_storage_root()?;
        Ok(read_daemon_state(&storage_root).map(|state| DaemonInfo {
            port: state.port,
            healthy: http_health(state.port),
        }))
    })
    .await
}

#[tauri::command]
async fn start_daemon() -> Result<DaemonInfo, String> {
    on_blocking(start_daemon_blocking).await
}

#[tauri::command]
async fn open_memoria() -> Result<String, String> {
    on_blocking(|| {
        let storage_root = resolve_storage_root()?;
        let state = read_daemon_state(&storage_root)
            .ok_or_else(|| "daemon.json introuvable — le daemon ne tourne pas ?".to_string())?;
        if !http_health(state.port) {
            return Err(format!("le daemon (port {}) ne répond pas au health check", state.port));
        }
        Ok(memoria_url(state.port, &state.admin_token))
    })
    .await
}

// ---------------------------------------------------------------------------
// Barre d'état (menu bar macOS / zone de notification Windows)
// Lettre « M » VERTE = daemon actif, ROUGE = éteint, GRISE = on ne sait pas
// (démarrage en cours, 1er sondage pas encore fait, ou impossible de sonder :
// la cause est alors dans l'info-bulle). Sondage toutes les 5 s. Icônes
// 44×44 (@2x) : tray-icon les redimensionne à la hauteur de la barre de
// menus, en couleur (non « template », sinon macOS les aplatirait en
// monochrome et l'état serait perdu).
// ---------------------------------------------------------------------------

const TRAY_ID: &str = "memoria-status";

/// État affiché par la barre d'état.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayState {
    /// Le daemon répond au health check.
    Active,
    /// Aucun daemon joignable.
    Down,
    /// Démarrage demandé, résultat pas encore connu.
    Starting,
    /// Impossible de conclure (pas encore sondé, ou sonde en erreur).
    Unknown,
}

impl TrayState {
    fn icon(self) -> Image<'static> {
        match self {
            TrayState::Active => Image::from_bytes(include_bytes!("../icons/m-green.png")).expect("icône M verte invalide"),
            TrayState::Down => Image::from_bytes(include_bytes!("../icons/m-red.png")).expect("icône M rouge invalide"),
            TrayState::Starting | TrayState::Unknown => {
                Image::from_bytes(include_bytes!("../icons/m-gray.png")).expect("icône M grise invalide")
            }
        }
    }
}

/// Ce que la barre d'état affiche : couleur du M + info-bulle. L'info-bulle
/// porte la cause quand l'état n'est pas trivial (« jamais de mort
/// silencieuse » : une sonde en erreur ou un démarrage raté doivent se voir).
#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayView {
    state: TrayState,
    tooltip: String,
}

impl TrayView {
    /// Avant le 1er sondage (fait hors thread principal, cf. `run`).
    fn checking() -> Self {
        Self { state: TrayState::Unknown, tooltip: "Memoria — vérification…".into() }
    }

    fn starting() -> Self {
        Self { state: TrayState::Starting, tooltip: "Memoria — démarrage…".into() }
    }

    /// Résultat d'un sondage : `Err` = on ne SAIT pas (config.toml invalide,
    /// HOME absent…), à ne pas confondre avec « éteint » — Démarrer échouerait
    /// pour la même raison, sans que l'utilisateur voie jamais laquelle.
    fn from_probe(probe: &Result<bool, String>) -> Self {
        match probe {
            Ok(true) => Self { state: TrayState::Active, tooltip: "Memoria — actif".into() },
            Ok(false) => Self {
                state: TrayState::Down,
                tooltip: "Memoria — éteint (clic → Démarrer)".into(),
            },
            Err(e) => Self { state: TrayState::Unknown, tooltip: format!("Memoria — état inconnu : {e}") },
        }
    }

    /// « Démarrer » a échoué : rouge, avec la cause (le log seul est invisible en GUI).
    fn down_after_failed_start(error: &str) -> Self {
        Self { state: TrayState::Down, tooltip: format!("Memoria — démarrage échoué : {error}") }
    }
}

/// Sondage du daemon (mêmes primitives que `daemon_health`, en synchrone).
/// `Err` = impossible de sonder, remonté tel quel (jamais aplati en `false`).
fn daemon_probe() -> Result<bool, String> {
    let root = resolve_storage_root()?;
    Ok(read_daemon_state(&root).map(|s| http_health(s.port)).unwrap_or(false))
}

/// Dernière erreur de « Démarrer », gardée tant que le daemon n'est pas revenu :
/// sans elle, la sonde 5 s écraserait la cause par un simple « éteint ».
static LAST_START_FAILURE: Mutex<Option<String>> = Mutex::new(None);

fn remember_start_failure(error: Option<&str>) {
    let mut slot = LAST_START_FAILURE.lock().unwrap_or_else(|e| e.into_inner());
    *slot = error.map(str::to_string);
}

/// Vue issue d'un sondage, en tenant compte d'un démarrage raté encore d'actualité.
fn probe_view(probe: &Result<bool, String>, last_start_failure: Option<&str>) -> TrayView {
    match (probe, last_start_failure) {
        (Ok(false), Some(error)) => TrayView::down_after_failed_start(error),
        _ => TrayView::from_probe(probe),
    }
}

/// Sonde puis construit la vue courante (efface l'erreur de démarrage dès que
/// le daemon répond).
fn current_tray_view() -> TrayView {
    let probe = daemon_probe();
    if probe == Ok(true) {
        remember_start_failure(None);
    }
    let failure = LAST_START_FAILURE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    probe_view(&probe, failure.as_deref())
}

/// « Ouvrir Memoria » : ramène la fenêtre de l'app (jamais le navigateur
/// externe) et l'envoie au bon endroit selon `open_target`. Appelé hors du
/// thread principal (health check bloquant).
fn open_memoria_window(app: &tauri::AppHandle) {
    let healthy = resolve_storage_root()
        .ok()
        .and_then(|root| read_daemon_state(&root))
        .filter(|state| http_health(state.port));
    match app.get_webview_window("main") {
        Some(window) => {
            let current = window.url().map(|u| u.to_string()).unwrap_or_default();
            let target = open_target(
                &current,
                healthy.as_ref().map(|s| (s.port, s.admin_token.as_str())),
            );
            if let Some(target) = target {
                match tauri::Url::parse(&target) {
                    Ok(url) => {
                        if let Err(e) = window.navigate(url) {
                            eprintln!("memoria-desktop: navigation vers {target} impossible : {e}");
                        }
                    }
                    Err(e) => eprintln!("memoria-desktop: URL cible invalide ({target}) : {e}"),
                }
            }
        }
        None => eprintln!("memoria-desktop: fenêtre principale introuvable — impossible d'ouvrir Memoria"),
    }
    show_main_window(app);
}

/// Fermer la dernière fenêtre ne doit PAS tuer l'app : la lettre M de la barre
/// d'état doit survivre à la croix rouge (sinon « Ouvrir Memoria » et l'état
/// « éteint (clic → Démarrer) » n'existent que fenêtre ouverte). wry envoie
/// `ExitRequested { code: None }` quand plus aucune fenêtre n'existe ;
/// `Some(_)` = sortie explicite (`app.exit`, menu Quitter). Cmd+Q passe par
/// `NSApp terminate:` (LoopDestroyed) et n'est donc jamais bloqué ici.
fn keep_running_without_window(exit_code: Option<i32>) -> bool {
    exit_code.is_none()
}

/// Ramène la fenêtre principale au premier plan (cachée par la croix rouge,
/// réduite dans le Dock, ou derrière une autre app).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// « Démarrer le daemon » n'a de sens que s'il ne tourne pas : actif, le clic
/// ferait clignoter gris→vert sans effet ; en cours, il doublerait le démarrage.
fn start_menu_enabled(state: TrayState) -> bool {
    matches!(state, TrayState::Down | TrayState::Unknown)
}

/// L'item « Démarrer le daemon », gardé dans l'état Tauri pour être
/// (dés)activé par `apply_tray_view` selon l'état affiché.
struct StartMenuItem(MenuItem<tauri::Wry>);

/// Dernière vue effectivement appliquée à la barre d'état.
static LAST_TRAY_VIEW: Mutex<Option<TrayView>> = Mutex::new(None);

/// Ce qu'il faut redessiner entre deux vues : `(icône, info-bulle)`. Chaque
/// `set_icon` décode le PNG, le ré-encode, alloue un NSImage et réveille le
/// thread principal — inutile 17 000 fois par jour pour un état qui change
/// quelques fois par jour (et source de micro-scintillement).
fn tray_changes(last: Option<&TrayView>, next: &TrayView) -> (bool, bool) {
    match last {
        None => (true, true),
        Some(last) => (last.state != next.state, last.tooltip != next.tooltip),
    }
}

/// Applique la vue (icône « M » + info-bulle) à la barre d'état, seulement
/// si elle change. À appeler HORS du thread principal : `set_icon` y est
/// dispatché et attend — et le verrou n'est jamais tenu pendant cet appel
/// (sinon un appel concurrent depuis le thread principal bloquerait tout).
fn apply_tray_view(app: &tauri::AppHandle, view: &TrayView) {
    let (icon, tooltip) = {
        let last = LAST_TRAY_VIEW.lock().unwrap_or_else(|e| e.into_inner());
        tray_changes(last.as_ref(), view)
    };
    if !icon && !tooltip {
        return;
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let mut applied = true;
    if icon {
        applied &= tray.set_icon(Some(view.state.icon())).is_ok();
    }
    if tooltip {
        applied &= tray.set_tooltip(Some(view.tooltip.clone())).is_ok();
    }
    if icon {
        if let Some(start) = app.try_state::<StartMenuItem>() {
            let _ = start.0.set_enabled(start_menu_enabled(view.state));
        }
    }
    if applied {
        let mut last = LAST_TRAY_VIEW.lock().unwrap_or_else(|e| e.into_inner());
        *last = Some(view.clone());
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            check_node,
            daemon_health,
            start_daemon,
            open_memoria
        ])
        .setup(|app| {
            // Menu de la pastille
            let open = MenuItem::with_id(app, "open", "Ouvrir Memoria", true, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "Démarrer le daemon", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &start, &sep, &quit])?;
            app.manage(StartMenuItem(start));

            // État initial : gris « vérification… ». Le 1er sondage est fait
            // par le thread de fond (ci-dessous, sans délai) : sonder ici
            // bloquerait le thread principal jusqu'à 4 s (timeouts TCP) si le
            // daemon est gelé, et la fenêtre n'apparaîtrait pas pendant ce temps.
            let initial = TrayView::checking();

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(initial.state.icon())
                .tooltip(&initial.tooltip)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        let app = app.clone();
                        std::thread::spawn(move || open_memoria_window(&app));
                    }
                    "start" => {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            // L'item peut être en retard d'un sondage : si le daemon
                            // tourne déjà, on rafraîchit la pastille sans clignoter.
                            if daemon_probe() == Ok(true) {
                                apply_tray_view(&app, &current_tray_view());
                                return;
                            }
                            // Gris pendant le démarrage : l'utilisateur voit que le clic a pris.
                            apply_tray_view(&app, &TrayView::starting());
                            match start_daemon_blocking() {
                                Ok(_) => remember_start_failure(None),
                                Err(e) => {
                                    eprintln!("memoria-desktop: démarrage du daemon échoué : {e}");
                                    remember_start_failure(Some(&e));
                                }
                            }
                            apply_tray_view(&app, &current_tray_view());
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            *LAST_TRAY_VIEW.lock().unwrap_or_else(|e| e.into_inner()) = Some(initial);

            // Sonde de fond : 1er sondage immédiat, puis toutes les 5 s.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                apply_tray_view(&handle, &current_tray_view());
                std::thread::sleep(Duration::from_secs(5));
            });

            Ok(())
        })
        // Croix rouge = cacher la fenêtre, pas la détruire : l'app reste dans
        // la barre d'état et « Ouvrir Memoria » la ré-affiche telle quelle.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("erreur au lancement de l'app bureau Memoria")
        .run(|app, event| match event {
            RunEvent::ExitRequested { code, api, .. } if keep_running_without_window(code) => {
                api.prevent_exit();
            }
            // Clic sur l'icône du Dock alors que la fenêtre est cachée.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows: false, .. } => show_main_window(app),
            _ => {}
        });
}

// ---------------------------------------------------------------------------
// Tests (sans réseau ni daemon réel ; fichiers en tmpdir)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    #[test]
    fn storage_root_from_plist_lit_l_argument_et_desechappe() {
        let xml = r#"<array>
      <string>/usr/local/bin/node</string>
      <string>/x/bin.js</string>
      <string>--storage-root</string>
      <string>/Users/r&amp;d/.memoria/data</string>
    </array>"#;
        assert_eq!(
            super::storage_root_from_plist(xml).as_deref(),
            Some("/Users/r&d/.memoria/data")
        );
        assert_eq!(super::storage_root_from_plist("<plist/>"), None);
        assert_eq!(super::storage_root_from_plist("<string>--storage-root</string>"), None);
    }

    use super::*;

    /// Dossier temporaire unique, nettoyé au drop.
    struct TmpDir(PathBuf);
    impl TmpDir {
        fn new(tag: &str) -> Self {
            let p = env::temp_dir().join(format!(
                "memoria-desktop-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            fs::create_dir_all(&p).expect("mkdir tmpdir");
            Self(p)
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parse_node_major_accepte_les_formats_usuels() {
        assert_eq!(parse_node_major("v22.1.0"), Some(22));
        assert_eq!(parse_node_major("v20.0.0\n"), Some(20));
        assert_eq!(parse_node_major("v9.11.2"), Some(9));
        assert_eq!(parse_node_major("22.1.0"), None); // pas de préfixe « v »
        assert_eq!(parse_node_major("garbage"), None);
        assert_eq!(parse_node_major(""), None);
    }

    #[test]
    fn config_toml_absent_donne_defaut() {
        let tmp = TmpDir::new("cfg-absent");
        let cfg = load_config(&tmp.0.join("config.toml")).expect("config par défaut");
        assert!(cfg.storage_path.is_none());
        assert!(cfg.daemon.is_none());
    }

    #[test]
    fn config_toml_lit_storage_path_et_daemon_bin() {
        let tmp = TmpDir::new("cfg-ok");
        let p = tmp.0.join("config.toml");
        fs::write(
            &p,
            "storage_path = \"/tmp/memoria-data\"\n[daemon]\nport = 0\nbin = \"/opt/memoria/bin.js\"\n[llm]\nprofile = \"100-local\"\n",
        )
        .unwrap();
        let cfg = load_config(&p).expect("parse");
        assert_eq!(cfg.storage_path.as_deref(), Some("/tmp/memoria-data"));
        assert_eq!(
            cfg.daemon.and_then(|d| d.bin).as_deref(),
            Some("/opt/memoria/bin.js")
        );
    }

    #[test]
    fn config_toml_corrompu_remonte_une_erreur() {
        let tmp = TmpDir::new("cfg-ko");
        let p = tmp.0.join("config.toml");
        fs::write(&p, "storage_path = [pas du toml").unwrap();
        let err = load_config(&p).expect_err("doit échouer");
        assert!(err.contains("config.toml invalide"), "message : {err}");
    }

    #[test]
    fn daemon_state_roundtrip_et_corruption() {
        let tmp = TmpDir::new("state");
        // absent → None
        assert!(read_daemon_state(&tmp.0).is_none());
        // valide → Some (format exact écrit par daemon/src/state.ts)
        fs::write(
            tmp.0.join("daemon.json"),
            "{\"daemon_id\":\"abc123\",\"port\":7437,\"admin_token\":\"tok_base64url\",\"pid\":4242,\"started_at\":\"2026-06-10T00:00:00.000Z\"}",
        )
        .unwrap();
        let state = read_daemon_state(&tmp.0).expect("état lu");
        assert_eq!(state.port, 7437);
        assert_eq!(state.admin_token, "tok_base64url");
        // corrompu → None (et trace stderr, pas de panique)
        fs::write(tmp.0.join("daemon.json"), "{pas du json").unwrap();
        assert!(read_daemon_state(&tmp.0).is_none());
    }

    #[test]
    fn url_ui_met_le_token_en_fragment() {
        assert_eq!(
            memoria_url(7437, "AbC-_123"),
            "http://127.0.0.1:7437/ui/#token=AbC-_123"
        );
    }

    #[test]
    fn reponse_health_reconnue() {
        assert!(is_healthy_response(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"version\":\"0.1.0\"}"
        ));
        assert!(!is_healthy_response("HTTP/1.1 401 Unauthorized\r\n\r\n{}"));
        assert!(!is_healthy_response("HTTP/1.1 200 OK\r\n\r\n{\"ok\":false}"));
        assert!(!is_healthy_response(""));
    }

    #[test]
    fn nvm_retient_le_major_le_plus_haut() {
        let tmp = TmpDir::new("nvm");
        for v in ["v18.20.0", "v22.3.0", "v9.11.2"] {
            fs::create_dir_all(tmp.0.join(v).join("bin")).unwrap();
        }
        let best = best_nvm_node(&tmp.0).expect("un candidat");
        assert!(best.ends_with("v22.3.0/bin/node"), "choisi : {}", best.display());
        // dossier absent → None, sans erreur
        assert!(best_nvm_node(&tmp.0.join("inexistant")).is_none());
    }

    #[test]
    fn health_refuse_un_port_ferme() {
        // Port réservé puis libéré aussitôt : connexion refusée ⇒ false.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!http_health(port));
    }

    #[test]
    fn fermer_la_derniere_fenetre_ne_quitte_pas_l_app() {
        // wry envoie `code: None` quand la dernière fenêtre est détruite : on
        // reste dans la barre d'état. `Some(_)` = Quitter explicite → on sort.
        assert!(keep_running_without_window(None));
        assert!(!keep_running_without_window(Some(0)));
        assert!(!keep_running_without_window(Some(1)));
    }

    #[test]
    fn ouvrir_memoria_cible_la_bonne_page() {
        let launch = launch_page_url();
        let ui = "http://127.0.0.1:7437/ui/#token=tok";
        // daemon éteint : la page de lancement (qui le redémarre, visiblement)
        assert_eq!(open_target(ui, None).as_deref(), Some(launch));
        assert_eq!(open_target(launch, None), None); // déjà dessus : on n'interrompt pas
        assert_eq!(open_target("", None).as_deref(), Some(launch)); // URL inconnue
        // daemon actif : l'UI, sauf si la webview y est déjà (état conservé)
        assert_eq!(open_target(launch, Some((7437, "tok"))).as_deref(), Some(ui));
        assert_eq!(open_target(ui, Some((7437, "tok"))), None);
        // daemon redémarré sur un autre port : on suit le nouveau port
        assert_eq!(
            open_target(ui, Some((7438, "tok2"))).as_deref(),
            Some("http://127.0.0.1:7438/ui/#token=tok2")
        );
    }

    #[test]
    fn la_pastille_distingue_inconnu_d_eteint() {
        // Sonde concluante : vert / rouge.
        assert_eq!(TrayView::from_probe(&Ok(true)).state, TrayState::Active);
        assert_eq!(TrayView::from_probe(&Ok(false)).state, TrayState::Down);
        // Impossible de sonder (config.toml invalide, HOME absent…) : gris
        // « inconnu » avec la cause dans l'info-bulle — pas un faux « éteint »
        // qui inviterait à Démarrer (et échouerait pour la même raison).
        let view = TrayView::from_probe(&Err("config.toml invalide (/x) : ligne 3".into()));
        assert_eq!(view.state, TrayState::Unknown);
        assert!(view.tooltip.contains("inconnu"), "{}", view.tooltip);
        assert!(view.tooltip.contains("config.toml invalide"), "{}", view.tooltip);
        // Avant le 1er sondage (fait hors thread principal) : gris aussi.
        assert_eq!(TrayView::checking().state, TrayState::Unknown);
        // Échec de « Démarrer » : rouge, mais la cause reste visible tant que
        // le daemon n'est pas revenu (la sonde 5 s ne l'écrase pas).
        let view = probe_view(&Ok(false), Some("Node.js ≥ 20 introuvable"));
        assert_eq!(view.state, TrayState::Down);
        assert!(view.tooltip.contains("Node.js ≥ 20 introuvable"), "{}", view.tooltip);
        assert_eq!(probe_view(&Ok(true), Some("vieille erreur")).state, TrayState::Active);
        assert_eq!(probe_view(&Ok(false), None), TrayView::from_probe(&Ok(false)));
    }

    #[test]
    fn la_pastille_n_est_redessinee_que_si_elle_change() {
        let active = TrayView::from_probe(&Ok(true));
        let down = TrayView::from_probe(&Ok(false));
        let down_with_cause = TrayView::down_after_failed_start("boum");
        // Rien d'affiché encore : tout redessiner.
        assert_eq!(tray_changes(None, &active), (true, true));
        // Même vue (cas de 99 % des sondages) : ne rien toucher.
        assert_eq!(tray_changes(Some(&active), &active), (false, false));
        // Changement d'état : icône ET info-bulle.
        assert_eq!(tray_changes(Some(&active), &down), (true, true));
        // Même couleur, seule la cause change : info-bulle seule.
        assert_eq!(tray_changes(Some(&down), &down_with_cause), (false, true));
    }

    #[test]
    fn demarrer_n_est_proposable_que_si_le_daemon_ne_tourne_pas() {
        assert!(!start_menu_enabled(TrayState::Active)); // sinon clignotement gris→vert sans effet
        assert!(!start_menu_enabled(TrayState::Starting)); // un démarrage est déjà en cours
        assert!(start_menu_enabled(TrayState::Down));
        assert!(start_menu_enabled(TrayState::Unknown)); // tenter révèle la cause dans l'info-bulle
    }
}
