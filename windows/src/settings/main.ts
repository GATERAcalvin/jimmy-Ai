// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus, type VoiceStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";
import { Recorder } from "../voice/recorder";
import { Speaker, listSystemVoices } from "../voice/speaker";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Jimmy is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "jimmy-hook.exe is not in place yet. Restart Jimmy; if it still fails, build it with `cargo build -p jimmy-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Jimmy's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? "Key saved in the Windows Credential Manager." : "No key yet — the chat needs one." });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? "Key saved in the Windows Credential Manager."
      : "No key yet — the chat needs one.";
    field.placeholder = present ? "••••••••••••  (stored)" : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Claude" })),
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    feedback,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Jimmy — ${used}/${MAX_ACTIVE} in use. Keys are stored in the Windows Credential Manager, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── Voice section ─────────────────────────────────────────────────────────────

const VOICE_LANGUAGES: [string, string][] = [
  ["auto", "Detect automatically"],
  ["en", "English"],
  ["fr", "French"],
  ["sw", "Swahili"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["de", "German"],
  ["ar", "Arabic"],
];

const ONLINE_VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];

function voiceSection(initial: VoiceStatus | null): HTMLElement {
  let status = initial;

  const dot = statusDot(false);
  const hotkeyLine = h("div", { class: "hint" });
  const modeHint = h("div", { class: "hint" });
  const offlineBox = h("div", {});
  const keyState = h("span", { class: "hint" });
  const testOut = h("div", { class: "hint", style: "min-height:18px" });

  // Switches and selects ------------------------------------------------------

  const enabled = toggle(settings.voiceEnabled, (v) => {
    settings.voiceEnabled = v;
    void save().then(() => setTimeout(refresh, 250));
  });

  const hotkey = h("input", {
    type: "text",
    value: settings.voiceHotkey,
    spellcheck: "false",
    autocomplete: "off",
    style: "width:170px",
  }) as HTMLInputElement;
  hotkey.addEventListener("change", () => {
    const v = hotkey.value.trim();
    if (!v) {
      hotkey.value = settings.voiceHotkey;
      return;
    }
    settings.voiceHotkey = v;
    void save().then(() => setTimeout(refresh, 250));
  });

  const mode = h("select", {}) as HTMLSelectElement;
  mode.append(
    h("option", { value: "auto", text: "Automatic: online when possible, else offline" }),
    h("option", { value: "online", text: "Online only" }),
    h("option", { value: "offline", text: "Offline only" }),
  );
  mode.value = settings.voiceMode;
  mode.addEventListener("change", () => {
    settings.voiceMode = mode.value as Settings["voiceMode"];
    void save();
    renderHints();
  });

  const language = h("select", {}) as HTMLSelectElement;
  for (const [code, label] of VOICE_LANGUAGES) language.append(h("option", { value: code, text: label }));
  language.value = settings.voiceLanguage;
  language.addEventListener("change", () => {
    settings.voiceLanguage = language.value;
    void save();
  });

  const speak = toggle(settings.voiceSpeak, (v) => {
    settings.voiceSpeak = v;
    void save();
  });

  // Online: Gemini -------------------------------------------------------------

  const keyField = h("input", {
    type: "password",
    placeholder: "AIza...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const keySave = h("button", { class: "primary", text: "Save key" });
  const keyClear = h("button", { class: "danger", text: "Remove" });
  const keyFeedback = h("div", {});

  keySave.addEventListener("click", async () => {
    const value = keyField.value.trim();
    if (!value) return;
    clear(keyFeedback);
    try {
      await Bridge.secretSet("gemini-api-key", value);
      keyField.value = "";
      keyFeedback.append(h("div", { class: "notice ok", text: "Saved in the Windows Credential Manager." }));
      await refresh();
    } catch (err) {
      keyFeedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });
  keyClear.addEventListener("click", async () => {
    clear(keyFeedback);
    try {
      await Bridge.secretClear("gemini-api-key");
      keyFeedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      keyFeedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  const onlineVoice = h("select", {}) as HTMLSelectElement;
  for (const v of ONLINE_VOICES) onlineVoice.append(h("option", { value: v, text: v }));
  if (!ONLINE_VOICES.includes(settings.ttsVoice)) settings.ttsVoice = "Kore"; // an old OpenAI voice name
  onlineVoice.value = settings.ttsVoice;
  onlineVoice.addEventListener("change", () => {
    settings.ttsVoice = onlineVoice.value;
    void save();
  });

  // Offline --------------------------------------------------------------------

  const cliPath = h("input", {
    type: "text",
    value: settings.whisperCliPath,
    placeholder: "Auto: whisper-cli.exe in the voice folder",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  cliPath.addEventListener("change", () => {
    settings.whisperCliPath = cliPath.value.trim();
    void save().then(() => setTimeout(refresh, 250));
  });
  const modelPath = h("input", {
    type: "text",
    value: settings.whisperModelPath,
    placeholder: "Auto: a ggml-*.bin model in the voice folder",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  modelPath.addEventListener("change", () => {
    settings.whisperModelPath = modelPath.value.trim();
    void save().then(() => setTimeout(refresh, 250));
  });

  const systemVoice = h("select", {}) as HTMLSelectElement;
  systemVoice.append(h("option", { value: "", text: "System default" }));
  void listSystemVoices().then((voices) => {
    for (const v of voices) systemVoice.append(h("option", { value: v.name, text: `${v.name} (${v.lang})` }));
    systemVoice.value = settings.offlineVoice;
  });
  systemVoice.addEventListener("change", () => {
    settings.offlineVoice = systemVoice.value;
    void save();
  });

  // Tests ----------------------------------------------------------------------

  const testVoice = h("button", { class: "primary", text: "Test voice" });
  testVoice.addEventListener("click", async () => {
    if (Speaker.speaking) {
      Speaker.stop();
      return;
    }
    testOut.textContent = "Speaking…";
    testVoice.textContent = "Stop";
    try {
      const { engine } = await Speaker.speak("Hello! Voice is working.", {
        offlineVoice: settings.offlineVoice,
      });
      testOut.textContent = `Spoken with: ${engine === "gemini" ? "Gemini (online)" : "a system voice (offline)"}.`;
    } catch (err) {
      testOut.textContent = `Could not speak: ${String(err).replace(/^Error:\s*/, "")}`;
    }
    testVoice.textContent = "Test voice";
  });

  const rec = new Recorder();
  let autoStop: number | null = null;
  const testMic = h("button", { class: "primary", text: "Test microphone" });

  async function finishMicTest() {
    if (autoStop != null) {
      window.clearTimeout(autoStop);
      autoStop = null;
    }
    testMic.textContent = "Test microphone";
    const r = await rec.stop();
    if (!r || r.peak < 0.01) {
      testOut.textContent = "I didn't hear anything. Check the microphone and try again.";
      return;
    }
    testOut.textContent = "Transcribing…";
    try {
      const t = await Bridge.voiceTranscribe(r.wav);
      const how = t.engine === "gemini" ? "Gemini (online)" : "whisper.cpp (offline)";
      testOut.textContent = t.text ? `Heard via ${how}: “${t.text}”` : `Heard nothing via ${how}.`;
    } catch (err) {
      testOut.textContent = String(err).replace(/^Error:\s*/, "");
    }
  }
  rec.onLimit = () => void finishMicTest();
  testMic.addEventListener("click", async () => {
    if (rec.active) {
      await finishMicTest();
      return;
    }
    testOut.textContent = "Listening… click again to stop (4 seconds at most).";
    testMic.textContent = "Stop";
    try {
      await rec.start();
      autoStop = window.setTimeout(() => void finishMicTest(), 4000);
    } catch (err) {
      testMic.textContent = "Test microphone";
      testOut.textContent = String(err).replace(/^Error:\s*/, "");
    }
  });

  // Rendering ------------------------------------------------------------------

  function renderHints() {
    const online = status?.geminiKey ?? false;
    const offline = status?.offlineReady ?? false;
    const m = settings.voiceMode;
    if (m === "online") {
      modeHint.textContent = online
        ? "Everything goes through Gemini. Needs an internet connection."
        : "Online only, but no Gemini key is saved yet.";
    } else if (m === "offline") {
      modeHint.textContent = offline
        ? "Speech is transcribed on this computer, and answers use a system voice. No audio leaves it."
        : "Offline only, but the offline engine isn't set up yet (see below).";
    } else if (online && offline) {
      modeHint.textContent = "Online first; if that fails or there is no connection, it switches to offline.";
    } else if (online) {
      modeHint.textContent = "Using online. Set up the offline engine to keep working without internet.";
    } else if (offline) {
      modeHint.textContent = "Using offline. Add a Gemini key for a more natural voice and better accuracy.";
    } else {
      modeHint.textContent = "Nothing is ready yet: save a Gemini key, or set up the offline engine.";
    }
  }

  function renderOffline() {
    clear(offlineBox);
    if (!status) return;
    if (status.offlineReady) {
      offlineBox.append(
        h("div", { class: "notice ok", text: "Offline transcription is ready." }),
        h("div", { class: "hint", text: `Engine: ${status.whisperCli}` }),
        h("div", { class: "hint", text: `Model: ${status.whisperModel}` }),
      );
    } else {
      offlineBox.append(
        h("div", {
          class: "notice err",
          text:
            "Offline transcription isn't set up. In the project's windows folder run: " +
            "powershell -ExecutionPolicy Bypass -File scripts\\setup-offline-voice.ps1 " +
            `(or place whisper-cli.exe and a ggml-*.bin model in ${status.voiceDir}).`,
        }),
      );
    }
  }

  async function refresh() {
    status = (await Bridge.voiceStatus()) ?? status;
    if (!status) return;
    dot.style.background = status.geminiKey || status.offlineReady ? "#22c55e" : "#f4505e";
    keyState.textContent = status.geminiKey
      ? "Key saved in the Windows Credential Manager."
      : "No key saved. Optional if you only use offline.";
    keyField.placeholder = status.geminiKey ? "••••••••••••  (stored)" : "AIza...";
    keyClear.style.display = status.geminiKey ? "" : "none";

    hotkeyLine.className = "hint";
    if (!settings.voiceEnabled) {
      hotkeyLine.textContent = "Voice is off.";
    } else if (status.hotkeyError) {
      hotkeyLine.textContent = status.hotkeyError;
      hotkeyLine.style.color = "#f4505e";
    } else if (status.hotkeyRegistered) {
      hotkeyLine.textContent = `Hold ${status.hotkeyRegistered} anywhere to talk.`;
      hotkeyLine.style.color = "";
    }
    renderHints();
    renderOffline();
  }
  void refresh();
  keyClear.style.display = initial?.geminiKey ? "" : "none";

  return h(
    "section",
    {},
    h("h2", {}, dot, h("span", { text: "Voice" })),
    h("div", {
      class: "hint",
      text: "Hold the hotkey, speak, let go. Jimmy writes down what you said, asks Claude, and reads the answer aloud. One Gemini key covers hearing and speaking.",
    }),
    h("div", { class: "row" }, h("label", { text: "Voice" }), enabled),
    h("div", { class: "row" }, h("label", { text: "Hotkey" }), hotkey),
    hotkeyLine,
    h("div", { class: "row" }, h("label", { text: "Engines" }), mode),
    modeHint,
    h("div", { class: "row" }, h("label", { text: "Language" }), language),
    h("div", { class: "row" }, h("label", { text: "Speak replies" }), speak),

    h("div", { class: "hint", style: "font-weight:600;margin-top:12px", text: "Online (Gemini)" }),
    keyState,
    h("div", { class: "row" }, h("label", { text: "Gemini key" }), keyField, keySave, keyClear),
    keyFeedback,
    h("div", { class: "row" }, h("label", { text: "Voice" }), onlineVoice),

    h("div", { class: "hint", style: "font-weight:600;margin-top:12px", text: "Offline" }),
    offlineBox,
    h("div", { class: "row" }, h("label", { text: "whisper.cpp" }), cliPath),
    h("div", { class: "row" }, h("label", { text: "Model" }), modelPath),
    h("div", { class: "row" }, h("label", { text: "System voice" }), systemVoice),

    h("div", { class: "row", style: "margin-top:12px" }, testMic, testVoice),
    testOut,
  );
}

// ── Assistant section: screen, listening, e-mail & calendar, alarms ───────────

function hotkeyInput(get: () => string, set: (v: string) => void): HTMLInputElement {
  const input = h("input", {
    type: "text", value: get(), spellcheck: "false", autocomplete: "off", style: "width:170px",
  }) as HTMLInputElement;
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (!v) {
      input.value = get();
      return;
    }
    set(v);
    void save();
  });
  return input;
}

function secretRow(label: string, key: string, placeholder: string, onChange: () => void): HTMLElement {
  const field = h("input", {
    type: "password", placeholder, style: "flex:1 1 auto;min-width:0", autocomplete: "off", spellcheck: "false",
  }) as HTMLInputElement;
  const saveBtn = h("button", { class: "primary", text: "Save" });
  const state = h("span", { class: "hint" });
  async function refresh() {
    const present = (await Bridge.secretPresent(key)) ?? false;
    field.placeholder = present ? "••••••••••••  (stored)" : placeholder;
    state.textContent = present ? "saved" : "";
  }
  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    try {
      await Bridge.secretSet(key, value);
      field.value = "";
    } catch (err) {
      state.textContent = `Could not save: ${String(err)}`;
    }
    await refresh();
    onChange();
  });
  void refresh();
  return h("div", { class: "row" }, h("label", { text: label }), field, saveBtn, state);
}

function assistSection(): HTMLElement {
  const screenKey = hotkeyInput(() => settings.screenHotkey, (v) => (settings.screenHotkey = v));
  const listenKey = hotkeyInput(() => settings.listenHotkey, (v) => (settings.listenHotkey = v));

  // Google ----------------------------------------------------------------------
  const googleState = h("div", { class: "hint" });
  const googleFeedback = h("div", {});
  const connect = h("button", { class: "primary", text: "Connect Google" });
  const disconnect = h("button", { class: "danger", text: "Disconnect" });
  async function refreshGoogle() {
    const g = await Bridge.googleStatus();
    googleState.textContent = g?.connected
      ? "Connected: Jimmy can read your unread mail and your calendar (read only)."
      : g?.configured
        ? "Client saved. Press Connect Google and approve in the browser."
        : "Not set up yet. Paste your OAuth client ID and secret below.";
    connect.style.display = g?.connected ? "none" : "";
    disconnect.style.display = g?.connected ? "" : "none";
  }
  connect.addEventListener("click", async () => {
    clear(googleFeedback);
    googleFeedback.append(h("div", { class: "notice", text: "Waiting for you to approve in the browser…" }));
    try {
      await Bridge.googleConnect();
      clear(googleFeedback);
      googleFeedback.append(h("div", { class: "notice ok", text: "Connected." }));
    } catch (err) {
      clear(googleFeedback);
      googleFeedback.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
    }
    await refreshGoogle();
  });
  disconnect.addEventListener("click", async () => {
    await Bridge.googleDisconnect().catch(() => {});
    await refreshGoogle();
  });
  void refreshGoogle();

  // Alarms ----------------------------------------------------------------------
  const list = h("div", {});
  const when = h("input", { type: "time", value: "07:00", style: "width:110px" }) as HTMLInputElement;
  const label = h("input", { type: "text", placeholder: "Label (optional)", style: "flex:1 1 auto;min-width:0" }) as HTMLInputElement;
  const repeat = h("select", {}) as HTMLSelectElement;
  repeat.append(
    h("option", { value: "none", text: "Once" }),
    h("option", { value: "daily", text: "Every day" }),
    h("option", { value: "weekdays", text: "Weekdays" }),
  );
  const add = h("button", { class: "primary", text: "Add alarm" });
  async function refreshAlarms() {
    const alarms = (await Bridge.alarmList()) ?? [];
    clear(list);
    if (!alarms.length) list.append(h("div", { class: "hint", text: "No alarms set." }));
    for (const a of alarms) {
      const remove = h("button", { class: "danger", text: "Remove" });
      remove.addEventListener("click", async () => {
        await Bridge.alarmRemove(a.id).catch(() => {});
        await refreshAlarms();
      });
      const at = new Date(a.atMs);
      const text = `${at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}  ·  ${a.label}${a.repeat === "none" ? "" : `  ·  ${a.repeat}`}`;
      list.append(h("div", { class: "row" }, h("span", { style: "flex:1 1 auto", text }), remove));
    }
  }
  add.addEventListener("click", async () => {
    const [hh, mm] = when.value.split(":").map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return;
    const at = new Date();
    at.setHours(hh, mm, 0, 0);
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
    await Bridge.alarmAdd(label.value.trim() || "Alarm", at.getTime(), repeat.value as "none" | "daily" | "weekdays").catch(() => {});
    label.value = "";
    await refreshAlarms();
  });
  void refreshAlarms();
  window.setInterval(() => void refreshAlarms(), 15_000);

  return h(
    "section",
    {},
    h("h2", {}, statusDot(true), h("span", { text: "Assistant" })),
    h("div", {
      class: "hint",
      text: "Hold the screen key and speak: Jimmy looks at your screen and answers. Tap it with nothing said and Jimmy works out what you need. " +
        "Listen mode keeps a short written record of what the microphone hears, so a question can use it. It is held in memory only, never saved, and the Windows microphone indicator is on while it runs.",
    }),
    h("div", { class: "row" }, h("label", { text: "Ask about screen" }), screenKey),
    h("div", { class: "row" }, h("label", { text: "Listen on/off" }), listenKey),
    h("div", { class: "hint", text: "Say \"read my screen\", \"read my WhatsApp\" (open WhatsApp Web first), or \"summarise my emails\" any time." }),

    h("div", { class: "hint", style: "font-weight:600;margin-top:12px", text: "E-mail and calendar (Google)" }),
    googleState,
    h("div", {
      class: "hint",
      text: "Create a free OAuth client of type Desktop app at console.cloud.google.com (enable the Gmail and Calendar APIs), then paste its ID and secret.",
    }),
    secretRow("Client ID", "google-client-id", "...apps.googleusercontent.com", () => void refreshGoogle()),
    secretRow("Client secret", "google-client-secret", "GOCSPX-...", () => void refreshGoogle()),
    h("div", { class: "row" }, connect, disconnect),
    googleFeedback,
    h("div", {
      class: "hint",
      text: "WhatsApp and Instagram have no official way to read a personal account's messages, so Jimmy reads them off the screen instead (the web versions, open in a browser).",
    }),

    h("div", { class: "hint", style: "font-weight:600;margin-top:12px", text: "Alarms" }),
    h("div", { class: "hint", text: "You can also just say \"wake me at 6:30\" or \"remind me in an hour to stretch\". Jimmy has to be running to ring, so turn on Start with Windows." }),
    list,
    h("div", { class: "row" }, when, label, repeat, add),
  );
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const voiceStatus = await Bridge.voiceStatus();

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Jimmy" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    apiSection(hasKey),
    voiceSection(voiceStatus),
    assistSection(),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
