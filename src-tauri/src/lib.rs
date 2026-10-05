//! Rats, I Typed It All: sends text as real keystrokes to whatever has focus.
//!
//! Windows is the primary target. Keystrokes go out through `enigo`, which
//! uses `SendInput` with `KEYEVENTF_UNICODE` on Windows and `CGEvent` on
//! macOS, so the text arrives regardless of the active keyboard layout and
//! lands in apps that refuse a clipboard paste.
//!
//! Everything the UI needs is pushed as events (`countdown`, `progress`,
//! `finished`) rather than polled, so the front end stays a thin view.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------- config

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeConfig {
    pub text: String,
    /// Characters per second.
    pub cps: f64,
    /// Vary keystroke timing and pause at punctuation.
    pub human: bool,
    /// enter | shiftEnter | space | skip
    pub newline_mode: String,
    /// tab | spaces
    pub tab_mode: String,
    pub spaces_per_tab: usize,
    pub countdown_secs: f64,
    /// Stop if the user switches away from the window they aimed at.
    pub stop_on_focus_change: bool,
    /// 1 types character by character; higher values send bursts, which is
    /// dramatically faster for large blocks into slow remote sessions.
    pub chunk_size: usize,
}

// ---------------------------------------------------------------- events

#[derive(Serialize, Clone)]
struct Tick {
    remaining: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    typed: usize,
    total: usize,
    elapsed_ms: u128,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Finished {
    typed: usize,
    total: usize,
    elapsed_ms: u128,
    stopped: bool,
    reason: Option<String>,
    error: Option<String>,
}

// ---------------------------------------------------------------- control

#[derive(Default)]
pub struct Control {
    running: AtomicBool,
    /// Set from the Stop button to abort a run.
    cancel: AtomicBool,
}

/// Is the physical Esc key held down right now?
///
/// The run polls this rather than registering a global hotkey: a hotkey can
/// fail to register (and did, silently), while asking the keyboard for its
/// current state always works, from any thread, whichever app is in front.
/// macOS reads the hardware state, so our own injected keystrokes never
/// count as a press.
#[cfg(target_os = "macos")]
fn esc_down() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
    }
    const HID_SYSTEM_STATE: i32 = 1;
    const KVK_ESCAPE: u16 = 0x35;
    unsafe { CGEventSourceKeyState(HID_SYSTEM_STATE, KVK_ESCAPE) }
}

#[cfg(windows)]
fn esc_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE};
    unsafe { (GetAsyncKeyState(VK_ESCAPE.0 as i32) as u16) & 0x8000 != 0 }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn esc_down() -> bool {
    false
}

fn stop_requested(control: &Control) -> bool {
    control.cancel.load(Ordering::Relaxed) || esc_down()
}

/// Sleep for `secs`, checking for a stop every 10ms so a quick tap of Esc
/// is caught even in a long pause. Returns true if a stop was requested.
fn nap(secs: f64, control: &Control) -> bool {
    let end = Instant::now() + Duration::from_secs_f64(secs.max(0.0));
    loop {
        if stop_requested(control) {
            return true;
        }
        let now = Instant::now();
        if now >= end {
            return false;
        }
        thread::sleep((end - now).min(Duration::from_millis(10)));
    }
}

pub struct AppState {
    control: Arc<Control>,
}

// ---------------------------------------------------------------- helpers

/// Small xorshift PRNG. Avoids pulling in `rand` for what is only jitter.
struct Rng(u64);

impl Rng {
    fn new() -> Self {
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x2545F4914F6CDD1D);
        Rng(seed | 1)
    }

    /// Uniform float in [lo, hi).
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        let unit = (self.0 >> 11) as f64 / (1u64 << 53) as f64;
        lo + unit * (hi - lo)
    }
}

/// Extra pause after these characters, as a multiple of the base delay.
fn pause_after(ch: char) -> f64 {
    match ch {
        '.' | '!' | '?' => 6.0,
        '\n' => 5.0,
        ',' | ';' | ':' => 3.0,
        ')' => 1.5,
        _ => 0.0,
    }
}

/// Identifies the window that currently has focus, so we can notice if the
/// user switches away mid-run and stop before text sprays somewhere wrong.
#[cfg(windows)]
fn foreground_window() -> isize {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe { GetForegroundWindow().0 as isize }
}

#[cfg(not(windows))]
fn foreground_window() -> isize {
    // Not yet implemented off Windows; 0 disables the guard.
    0
}

// ---------------------------------------------------------------- typing

fn send_newline(enigo: &mut Enigo, mode: &str) -> Result<(), String> {
    match mode {
        "skip" => Ok(()),
        "space" => enigo.text(" ").map_err(|e| e.to_string()),
        "shiftEnter" => {
            enigo
                .key(Key::Shift, Direction::Press)
                .map_err(|e| e.to_string())?;
            let r = enigo.key(Key::Return, Direction::Click).map_err(|e| e.to_string());
            // Release shift even if the Return failed, or the modifier sticks.
            let _ = enigo.key(Key::Shift, Direction::Release);
            r
        }
        _ => enigo
            .key(Key::Return, Direction::Click)
            .map_err(|e| e.to_string()),
    }
}

fn send_tab(enigo: &mut Enigo, mode: &str, spaces: usize) -> Result<(), String> {
    if mode == "spaces" {
        enigo
            .text(&" ".repeat(spaces.max(1)))
            .map_err(|e| e.to_string())
    } else {
        enigo
            .key(Key::Tab, Direction::Click)
            .map_err(|e| e.to_string())
    }
}

/// Single exit point for a run: tells the UI and clears the run flags. Every
/// way a run can end goes through here.
fn finish_run(
    app: &AppHandle,
    control: &Arc<Control>,
    typed: usize,
    total: usize,
    elapsed_ms: u128,
    reason: Option<String>,
    error: Option<String>,
) {
    let _ = app.emit(
        "finished",
        Finished {
            typed,
            total,
            elapsed_ms,
            stopped: reason.is_some(),
            reason,
            error,
        },
    );
    control.cancel.store(false, Ordering::Relaxed);
    control.running.store(false, Ordering::Relaxed);
}

/// The typing run. Executes on its own thread and reports through events.
fn run_typing(app: AppHandle, cfg: TypeConfig, control: Arc<Control>) {
    // ---- countdown, giving the user time to click into the target
    let mut remaining = cfg.countdown_secs.max(0.0);
    while remaining > 0.0 {
        let _ = app.emit("countdown", Tick { remaining });
        if nap(0.1, &control) {
            finish_run(&app, &control, 0, 0, 0, Some("Stopped.".into()), None);
            return;
        }
        remaining -= 0.1;
    }

    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(e) => e,
        Err(e) => {
            finish_run(
                &app,
                &control,
                0,
                0,
                0,
                None,
                Some(format!("Could not access the keyboard: {e}")),
            );
            return;
        }
    };

    let chars: Vec<char> = cfg.text.chars().collect();
    let total = chars.len();
    let base = 1.0 / cfg.cps.max(0.5);
    let chunk = cfg.chunk_size.max(1);
    let mut rng = Rng::new();

    // Whatever the user clicked into during the countdown is the target.
    let target_window = foreground_window();

    let started = Instant::now();
    let mut typed = 0usize;
    let mut stop_reason: Option<String> = None;
    let mut error: Option<String> = None;

    let mut i = 0usize;
    while i < total {
        // ---- stop requested from the Stop button or the Esc key?
        if stop_requested(&control) {
            stop_reason = Some("Stopped.".into());
            break;
        }

        // ---- safety guard: did they switch away from the target window?
        if cfg.stop_on_focus_change && target_window != 0 {
            let now = foreground_window();
            if now != 0 && now != target_window {
                stop_reason =
                    Some("Stopped: focus moved to another window.".into());
                break;
            }
        }

        let ch = chars[i];
        let result = if ch == '\n' {
            i += 1;
            send_newline(&mut enigo, &cfg.newline_mode)
        } else if ch == '\t' {
            i += 1;
            send_tab(&mut enigo, &cfg.tab_mode, cfg.spaces_per_tab)
        } else if chunk > 1 {
            // Burst mode: take a run of plain characters in one event.
            let mut buf = String::new();
            while i < total && buf.chars().count() < chunk {
                let c = chars[i];
                if c == '\n' || c == '\t' {
                    break;
                }
                buf.push(c);
                i += 1;
            }
            enigo.text(&buf).map_err(|e| e.to_string())
        } else {
            i += 1;
            enigo.text(&ch.to_string()).map_err(|e| e.to_string())
        };

        if let Err(e) = result {
            error = Some(e);
            break;
        }

        typed = i;
        let elapsed = started.elapsed();
        // Report often enough to feel live without flooding the UI.
        if typed % 8 == 0 || typed == total {
            let _ = app.emit(
                "progress",
                Progress {
                    typed,
                    total,
                    elapsed_ms: elapsed.as_millis(),
                },
            );
        }

        // ---- pacing
        let mut delay = base;
        if cfg.human {
            delay *= rng.range(0.55, 1.7);
            delay += base * pause_after(ch) * rng.range(0.6, 1.2);
        }
        if nap(delay, &control) {
            stop_reason = Some("Stopped.".into());
            break;
        }
    }

    let elapsed = started.elapsed();
    finish_run(
        &app,
        &control,
        typed,
        total,
        elapsed.as_millis(),
        stop_reason,
        error,
    );
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn start_typing(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    config: TypeConfig,
) -> Result<(), String> {
    if state.control.running.load(Ordering::Relaxed) {
        return Err("Already running.".into());
    }
    if config.text.is_empty() {
        return Err("Nothing to type.".into());
    }

    state.control.running.store(true, Ordering::Relaxed);
    state.control.cancel.store(false, Ordering::Relaxed);

    let control = state.control.clone();
    thread::spawn(move || run_typing(app, config, control));
    Ok(())
}

/// Ask the current run to stop. Safe to call when nothing is running.
#[tauri::command]
fn stop_typing(state: tauri::State<'_, AppState>) {
    state.control.cancel.store(true, Ordering::Relaxed);
}

/// Toggle whether the window floats above other windows. The typist is
/// normally kept on top so the target app never hides it, but some people
/// want it out of the way; this lets the UI switch it off.
#[tauri::command]
fn set_on_top(window: tauri::Window, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

/// macOS only delivers synthetic keystrokes from apps granted Accessibility
/// in System Settings, and it drops them silently otherwise: the run looks
/// normal but nothing arrives. The UI asks this up front so it can say so.
/// Sync commands run on the main thread, which is where this belongs.
#[tauri::command]
fn accessibility_ok() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXIsProcessTrusted() -> bool;
        }
        unsafe { AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Pops the system Accessibility prompt and opens the settings pane so the
/// user does not have to hunt for it. On macOS `AXIsProcessTrustedWithOptions`
/// with the prompt option registers this app in the Accessibility list and
/// shows the native "Open System Settings" dialog; we also open the pane
/// directly as a fallback in case macOS suppresses the dialog (it only shows
/// once per app). Returns the current trust state.
#[tauri::command]
fn open_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::raw::c_void;

        type CFRef = *const c_void;

        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            static kAXTrustedCheckOptionPrompt: CFRef;
            fn AXIsProcessTrustedWithOptions(options: CFRef) -> bool;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            static kCFAllocatorDefault: CFRef;
            static kCFBooleanTrue: CFRef;
            static kCFTypeDictionaryKeyCallBacks: c_void;
            static kCFTypeDictionaryValueCallBacks: c_void;
            fn CFDictionaryCreate(
                allocator: CFRef,
                keys: *const CFRef,
                values: *const CFRef,
                num_values: isize,
                key_cbs: *const c_void,
                value_cbs: *const c_void,
            ) -> CFRef;
            fn CFRelease(cf: CFRef);
        }

        let trusted = unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let opts = CFDictionaryCreate(
                kCFAllocatorDefault,
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            );
            let t = AXIsProcessTrustedWithOptions(opts);
            if !opts.is_null() {
                CFRelease(opts);
            }
            t
        };

        // Open the pane directly too, so the user lands on the right screen
        // even when the one-shot native dialog does not appear.
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();

        return trusted;
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn is_running(state: tauri::State<'_, AppState>) -> bool {
    state.control.running.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------- setup

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            control: Arc::new(Control::default()),
        })
        .invoke_handler(tauri::generate_handler![
            start_typing,
            stop_typing,
            set_on_top,
            accessibility_ok,
            open_accessibility,
            is_running
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rats, I Typed It All");
}
