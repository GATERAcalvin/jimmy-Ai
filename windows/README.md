<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Ruth icon">

# Ruth for Windows

**Ruth is a small companion that lives at the top of your screen.**

Approve Claude Code permissions, watch your session work, drop a file, chat with Claude, keep an eye on your services — without leaving what you're doing.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

</div>

---

## Install

The downloadable installer is **temporarily unavailable**. Microsoft Defender
wrongly flags the unsigned installer as malware (`Trojan:Win32/Wacatac.H!ml`, a
machine-learning false positive). A report is under review at Microsoft, and the
installer will be published again once it is cleared and code-signed.

Until then, [build it yourself](#build-it-yourself): it takes a few minutes and
installs for the current user only — no admin prompt.

## Using it


| What you do | What happens |
|---|---|
| Move the mouse to the very top-centre of the screen | Ruth peeks out |
| Click the small island | It opens |
| Click Ruth | It gets annoyed. Three times in a row and it goes dizzy |
| Rest the pointer on Ruth for two seconds | Hearts |
| Drag a file onto the island | Ruth turns into a box, swallows it, then offers to answer questions about it |
| `Esc` | Closes the island |
| Tray icon | Open, Settings…, Pause, Quit |

Everything else happens on its own: a Claude Code permission request opens the
island with **Deny / Allow**, a finished session shows what it did, and
your integrations sit in the coloured pills next to Ruth.

## Claude Code


Open **Settings… → Claude Code → Install hooks…**. You get the exact diff of what
will change in `%USERPROFILE%\.claude\settings.json`, the path of the dated backup
that will be taken, and nothing is written until you click. Your own hooks are
never touched, and uninstalling removes only Ruth's entries.

The relay is a tiny executable, `ruth-hook.exe`, copied to
`%LOCALAPPDATA%\Ruth\bin\` at launch. It is given 300 ms to reach Ruth and
exits cleanly if the app is closed, slow or crashed — **a Claude Code session is
never blocked or slowed down by Ruth.** If nobody answers a permission request
in time, Ruth stays quiet and Claude Code asks in the terminal as usual.

It works from any terminal — Windows Terminal, PowerShell, VS Code, Git Bash.

## Chat and keys

**Settings… → Claude** takes your Anthropic API key. Keys live in the **Windows
Credential Manager**, never on disk and never in the interface — the island can
only ask whether a key exists. Same for every integration key.

No telemetry. The only network requests Ruth makes are to the services you
configure yourself.

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the
**MSVC build tools** (Visual Studio Build Tools with "Desktop development with
C++"). WebView2 ships with Windows 10/11.

```powershell
cd windows
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # builds the installer and drops it in windows/release/
```

`npm run dev` alone serves the front end in an ordinary browser, which is enough
to work on the island's looks. It also serves `dev/upload-preview.html`, which
replays the whole file-drop choreography on a loop — the one part of the UI that
otherwise needs a real drag from Explorer to see. Neither page ships in the app.

`npm run pack` leaves two files in `windows/release/`, the same names the release
workflow publishes:

```
Ruth-Windows-X.Y.Z-setup.exe    the versioned installer
Ruth-Windows-setup.exe          the same file under the rolling name
```

Installing is optional — `target/release/ruth.exe` runs on its own. There is no
window in the taskbar and no console: the island at the top of the screen and the
Ruth in the notification area are the whole app, and Quit lives in its menu.

The 28 sounds are Ruth's own, synthesised by `scripts/gen-sounds.py` into
`public/sounds/` (Vite serves and bundles that folder as-is).

The app icon, the tray icon and the sounds are all generated in code, like Ruth
itself:

```powershell
npm run icons          # regenerates src-tauri/icons from scripts/gen-icons.mjs
python scripts/gen-sounds.py   # regenerates public/sounds
```

### Layout

```
windows/
  src/                 island front end (TypeScript, no framework)
    ruth/             Ruth and the launch greeting, in Canvas 2D
    island/            state machine, hooks, integrations
    views/             every island view
    settings/          the settings window
  src-tauri/           Rust backend: window, named pipe, Claude API, pollers
  hook/                ruth-hook.exe, the Claude Code relay
  public/sounds/       Ruth's 28 sound effects
  scripts/             icon and sound generators
```

### Log

`%LOCALAPPDATA%\Ruth\ruth.log` — hook events, permission decisions, poller
problems. It stays on your machine.

## Not included

- Sending a file by email, dragging Ruth onto a window to attach it as context,
  and jumping to a specific terminal window. "Open terminal" opens the working
  folder in VS Code when `code` is on your `PATH`.
- Cal.com shows the next bookings as a list.

## Credits

Ruth is built on [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé,
released under the MIT License (see `LICENSE`). The island, hook relay and
animation engine come from Coucou. Ruth's character, icons and sounds are new.

## Linux

The same app builds for Linux: everything that differs lives in
`src-tauri/src/platform/`, and the relay's transport in `hook/src/unix.rs`.

```bash
sudo apt install build-essential pkg-config \
  libwebkit2gtk-4.1-dev libgtk-layer-shell-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libdbus-1-dev patchelf \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # AppImage, .deb and .rpm in windows/release/
```

What changes on Linux:

- **The island** is a gtk-layer-shell overlay anchored to the top edge, over any
  top panel, on compositors that support it: COSMIC, KDE Plasma, Hyprland, Sway
  and other wlroots compositors. GNOME has no layer-shell, so there the island
  is a regular window. `RUTH_LAYER_SHELL=0` forces that mode anywhere.
- **Click-through** is the window's input region, kept equal to the island
  shape, so the compositor sends every other click to what is underneath.
- **Ruth's eyes** follow the pointer only while it is over the island: Wayland
  gives no app the cursor position anywhere else.
- **Claude Code hooks** go through `~/.local/share/ruth/bin/ruth-hook` and a
  Unix socket at `$XDG_RUNTIME_DIR/ruth.sock`. Both ends check that the other
  runs as the same user.
- **Keys** live in the Secret Service (GNOME Keyring, KWallet).
- **Files**: preferences in `~/.config/ruth/`, the log at
  `~/.local/share/ruth/ruth.log`.
- What the Windows build leaves out, this one does too (see "Not included").
