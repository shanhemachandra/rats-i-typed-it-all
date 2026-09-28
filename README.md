# Shans Typer

Sends your text to any application as real keystrokes, so it arrives in
places a clipboard paste cannot reach: remote desktop sessions with the
clipboard disabled, fields that block pasting, and legacy software with no
import path.

Windows is the primary target. macOS is supported from the same codebase.

This is a separate project from the original `typing-app`, which is left
untouched as the working macOS reference implementation.

## Status

Builds and runs. The macOS build produces a 1.4 MB `.dmg`. The text
pipeline has 28 passing tests (`npm test`).

Not yet signed, and not yet run on real Windows hardware. See "What still
needs doing" at the bottom.

## Running it in development

```bash
npm install
npm run dev
```

## Replacing the app icon

Save the artwork as `assets/icon-source.png`, then regenerate every size:

```bash
npm run icon
```

The source should be square and at least 1024 by 1024 pixels, with a
transparent background. That one command writes the Windows `.ico`, the
macOS `.icns` and all the PNG sizes into `src-tauri/icons/`.

Building installers locally:

```bash
npm run build
```

On macOS this produces a `.dmg`. Windows installers cannot be built from a
Mac, which is what the GitHub Actions workflow is for.

## Shipping installers

Push a version tag and CI builds both installers into a draft release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds the Windows `.exe` on a Windows
runner and a universal macOS `.dmg` on a macOS runner.

## Code signing is required before selling

An unsigned executable that injects keystrokes is a hard commercial
problem, not a cosmetic one:

| Platform | Without signing | What you need |
|---|---|---|
| Windows | SmartScreen "unknown publisher" wall, plus frequent antivirus false positives, because keystroke injection looks like a keylogger | OV certificate, roughly $200 to $400 per year, now requiring a hardware token or cloud HSM. EV costs more but grants SmartScreen reputation immediately |
| macOS | Gatekeeper refuses to open the app at all | Apple Developer ID at $99 per year, plus notarization, which is free |

Signing secrets are wired into the workflow already. Add them under
repository Settings, Secrets and variables, Actions.

## How it works

The front end (`src/`) owns the text pipeline: cleanup, table conversion
and indent stripping all happen in JavaScript, so the Rust side receives a
finished character sequence plus pacing options.

The back end (`src-tauri/src/lib.rs`) runs the typing loop on its own
thread and reports through events. Keystrokes go out through `enigo`,
which uses `SendInput` with `KEYEVENTF_UNICODE` on Windows and `CGEvent` on
macOS, so text arrives correctly regardless of the active keyboard layout.

## Features

**Tables.** Keystrokes carry characters, not structure, so the table itself
has to come from the target app. Paste TSV or CSV and pick a target:

- *Spreadsheet*: cells separated by Tab, rows by Enter. Excel and Sheets
  assemble the grid natively, and Enter returns to the first column.
- *Existing table in Word or Docs*: every cell separated by Tab, because
  Tab past the last cell opens a new row.

CSV parsing handles quoted fields and embedded commas. Newlines inside a
cell are flattened, since they would otherwise break the grid.

**Enter key behavior.** The most important safety setting. In Slack, Teams
and terminals, Enter sends or executes, so multi-line text would fire as
many separate messages or run as many commands. Options are Enter,
Shift plus Enter, replace with a space, or ignore.

**Text cleanup.** Optional replacement of em dashes and en dashes with a
plain hyphen (on by default), curly quotes with straight quotes, the
ellipsis character with three dots, and non breaking spaces with normal
spaces. Useful for legacy systems and terminals that mangle non ASCII
input.

**Fast burst mode.** Sends text in blocks rather than character by
character, which is dramatically quicker for large blocks going into slow
remote sessions.

**Focus guard.** Stops automatically if focus leaves the window you aimed
at, so text does not spray into the wrong application. Windows only for
now.

**Pause and resume**, with paused time excluded from the timer.

**Timer.** Reports on completion as `Done - typed 1,234 characters in
2 minutes 4 seconds`.

## What still needs doing

- Test on real Windows hardware. Nothing here has run on Windows yet.
- Global stop hotkey. The plugin is wired in but no shortcut is registered,
  so stopping currently means clicking Cancel in the window.
- Focus guard for macOS. Currently a no-op off Windows.
- Snippet library and field by field mode, both previously discussed.
- Licensing and payment integration.

## Known platform limits

- Windows will not let a normal process type into an elevated admin
  window. The app would need to run elevated to reach one.
- macOS requires Accessibility permission before any keystroke is
  delivered. Windows needs no equivalent permission.
