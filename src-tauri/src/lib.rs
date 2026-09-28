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

/// The typing run. Executes on its own thread and reports through events.
fn run_typing(app: AppHandle, cfg: TypeConfig, control: Arc<Control>) {
    // ---- countdown, giving the user time to click into the target
    let mut remaining = cfg.countdown_secs.max(0.0);
    while remaining > 0.0 {
        let _ = app.emit("countdown", Tick { remaining });
        thread::sleep(Duration::from_millis(100));
        remaining -= 0.1;
    }

    let mut enigo = match Enigo::new(&Settings::default()) {
        Ok(e) => e,
        Err(e) => {
            let _ = app.emit(
                "finished",
                Finished {
                    typed: 0,
                    total: 0,
                    elapsed_ms: 0,
                    stopped: false,
                    reason: None,
                    error: Some(format!("Could not access the keyboard: {e}")),
                },
            );
            control.running.store(false, Ordering::Relaxed);
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
        if delay > 0.0 {
            thread::sleep(Duration::from_secs_f64(delay));
        }
    }

    let elapsed = started.elapsed();
    let _ = app.emit(
        "finished",
        Finished {
            typed,
            total,
            elapsed_ms: elapsed.as_millis(),
            stopped: stop_reason.is_some(),
            reason: stop_reason,
            error,
        },
    );
    control.running.store(false, Ordering::Relaxed);
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

    let control = state.control.clone();
    thread::spawn(move || run_typing(app, config, control));
    Ok(())
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
            accessibility_ok,
            is_running
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rats, I Typed It All");
}
