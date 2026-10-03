# Ruth

A small companion for [Claude Code](https://claude.com/claude-code) that lives at the top of your screen. It shows your sessions, lets you approve or deny permission requests, chat with Claude and drop files, without leaving what you are doing.

The app is in [`windows/`](windows/README.md) (Tauri 2, TypeScript, Rust). It builds for Windows 10/11 and also for Linux.

```powershell
cd windows
npm install
npm run tauri dev      # development build
npm run pack           # installer in windows/release/
```

## Credits and license

Ruth is a derivative of [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raillé, used under the MIT License. The original copyright notice is kept in [`LICENSE`](LICENSE).

Coucou's name, the Mochi character, its icons and its sounds are reserved by their author and are **not** part of this repository. Ruth's character, icons and sounds are original and generated in code (`windows/src/ruth/`, `windows/scripts/`).
