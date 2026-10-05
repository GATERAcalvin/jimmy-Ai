<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Jimmy icon">

# Jimmy for Windows

**Jimmy is a small companion that lives at the top of your screen.**

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
| Move the mouse to the very top-centre of the screen | Jimmy peeks out |
| Click the small island | It opens |
| Click Jimmy | It gets annoyed. Three times in a row and it goes dizzy |
| Rest the pointer on Jimmy for two seconds | Hearts |
| Drag a file onto the island | Jimmy turns into a box, swallows it, then offers to answer questions about it |
| `Esc` | Closes the island |
| Tray icon | Open, Settings…, Pause, Quit |

Everything else happens on its own: a Claude Code permission request opens the
island with **Deny / Allow**, a finished session shows what it did, and
your integrations sit in the coloured pills next to Jimmy.

## Claude Code


Open **Settings… → Claude Code → Install hooks…**. You get the exact diff of what
will change in `%USERPROFILE%\.claude\settings.json`, the path of the dated backup
that will be taken, and nothing is written until you click. Your own hooks are
never touched, and uninstalling removes only Jimmy's entries.

The relay is a tiny executable, `jimmy-hook.exe`, copied to
`%LOCALAPPDATA%\Jimmy\bin\` at launch. It is given 300 ms to reach Jimmy and
exits cleanly if the app is closed, slow or crashed — **a Claude Code session is
never blocked or slowed down by Jimmy.** If nobody answers a permission request
in time, Jimmy stays quiet and Claude Code asks in the terminal as usual.

It works from any terminal — Windows Terminal, PowerShell, VS Code, Git Bash.

## Chat and keys

**Settings… → Claude** takes your Anthropic API key. Keys live in the **Windows
Credential Manager**, never on disk and never in the interface — the island can
only ask whether a key exists. Same for every integration key.

No telemetry. The only network requests Jimmy makes are to the services you
configure yourself.

## Voice

Hold **Ctrl+Alt+J** (change it in Settings → Voice), say something, let go. Jimmy
transcribes it, asks Claude, shows the answer and reads it aloud. You can also
click the mic button in the chat bar. Press the hotkey while Jimmy is talking to
cut in with your next question.

It works online, offline, or both:

| | Online | Offline |
|---|---|---|
| **Hearing you** | OpenAI transcription | whisper.cpp on your PC |
| **Speaking** | OpenAI voices | the Windows voices |
| **Needs** | an OpenAI key + internet | a one-time download (below) |
| **Audio leaves your PC** | yes, to OpenAI | no |

*Engines* in Settings → Voice picks the mode. **Automatic** (the default) uses
online when a key is saved and the call works, and falls back to offline
otherwise, so voice keeps working when the connection drops. Claude itself is
still online: the answer to your question always comes from the Claude API.

**Online:** paste an OpenAI key under Settings → Voice. It is stored in the
Windows Credential Manager like the other keys.

**Offline:** run this once from the `windows` folder. It downloads whisper.cpp
and a speech model (75 MB to 470 MB depending on the model) into
`%APPDATA%\Jimmy\voice`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-offline-voice.ps1            # "base" model
powershell -ExecutionPolicy Bypass -File scripts\setup-offline-voice.ps1 -Model small  # more accurate, slower
```

Settings → Voice shows whether the offline engine was found, and has
**Test microphone** and **Test voice** buttons that run the whole chain without
involving Claude.

Notes:

- The first time, Windows asks whether Jimmy may use the microphone. Say yes, then
  try again. If you said no: Windows Settings → Privacy & security → Microphone.
- The microphone is open only while you hold the key. Nothing is recorded in the
  background, and offline recordings are deleted right after they are transcribed.
- The hotkey is global, so pick a combination no other app uses. Settings →
  Voice tells you if it could not be registered.
- Spoken questions get a shorter, more conversational answer than typed ones.
- Status: the Rust side compiles and is unit-tested (engine plumbing, hotkey
  parsing, text cleanup), and the recording path was checked against a generated
  tone. It has **not yet been run end to end on a Windows PC with a real
  microphone**, so expect some rough edges the first time.
- `scripts\setup-offline-voice.ps1` has not been run on Windows either. whisper.cpp
  attaches its Windows builds to the `bNNNN` build releases, not to the release
  marked "latest", so the script takes the newest release that has
  `whisper-bin-x64.zip`. If a download step fails, it says which file to fetch by hand.
- On Linux it compiles, but global hotkeys (Wayland) and microphone access in the
  web view are untested.
- Online models: transcription uses `whisper-1` and speech uses `tts-1`; both still
  work, and newer OpenAI models exist. They are two constants at the top of
  `src-tauri/src/voice.rs`.

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
Jimmy-Windows-X.Y.Z-setup.exe    the versioned installer
Jimmy-Windows-setup.exe          the same file under the rolling name
```

Installing is optional — `target/release/jimmy.exe` runs on its own. There is no
window in the taskbar and no console: the island at the top of the screen and the
Jimmy in the notification area are the whole app, and Quit lives in its menu.

The 28 sounds are Jimmy's own, synthesised by `scripts/gen-sounds.py` into
`public/sounds/` (Vite serves and bundles that folder as-is).

The app and tray icons are cut from `assets/icon-source.jpg` (the portrait), and
the sounds are synthesised in code:

```powershell
pip install pillow
npm run icons          # rebuilds src-tauri/icons from assets/icon-source.jpg
npm run icons:drawn    # the older drawn-in-code Jimmy icon instead
python scripts/gen-sounds.py   # regenerates public/sounds
```

To change the icon, replace `assets/icon-source.jpg` (and adjust `CROP` in
`scripts/icon-from-image.py`), then run `npm run icons`.

### Layout

```
windows/
  src/                 island front end (TypeScript, no framework)
    jimmy/             Jimmy and the launch greeting, in Canvas 2D
    island/            state machine, hooks, integrations
    views/             every island view
    voice/             push-to-talk: recorder, speaker, controller
    settings/          the settings window
  src-tauri/           Rust backend: window, named pipe, Claude API, pollers
  hook/                jimmy-hook.exe, the Claude Code relay
  public/sounds/       Jimmy's 28 sound effects
  public/voice-worklet.js   microphone capture (audio thread)
  scripts/             icon and sound generators, offline voice setup
```

### Log

`%LOCALAPPDATA%\Jimmy\jimmy.log` — hook events, permission decisions, poller
problems. It stays on your machine.

## Not included

- Sending a file by email, dragging Jimmy onto a window to attach it as context,
  and jumping to a specific terminal window. "Open terminal" opens the working
  folder in VS Code when `code` is on your `PATH`.
- Cal.com shows the next bookings as a list.

## Credits

Jimmy is built on [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé,
released under the MIT License (see `LICENSE`). The island, hook relay and
animation engine come from Coucou. Jimmy's character, icons and sounds are new.

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
  is a regular window. `JIMMY_LAYER_SHELL=0` forces that mode anywhere.
- **Click-through** is the window's input region, kept equal to the island
  shape, so the compositor sends every other click to what is underneath.
- **Jimmy's eyes** follow the pointer only while it is over the island: Wayland
  gives no app the cursor position anywhere else.
- **Claude Code hooks** go through `~/.local/share/jimmy/bin/jimmy-hook` and a
  Unix socket at `$XDG_RUNTIME_DIR/jimmy.sock`. Both ends check that the other
  runs as the same user.
- **Keys** live in the Secret Service (GNOME Keyring, KWallet).
- **Files**: preferences in `~/.config/jimmy/`, the log at
  `~/.local/share/jimmy/jimmy.log`.
- What the Windows build leaves out, this one does too (see "Not included").
