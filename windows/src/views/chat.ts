// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView from
// IslandViewContent.swift.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ChatContext } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import { handleLocalCommand } from "../assist/commands";
import type { ViewHost } from "./views";

let nextId = 1;

/** True while a question is with Claude. Shared by typing and voice. */
let sending = false;
let heightChanged: () => void = () => {};
let focusInput: () => void = () => {};

export function isChatBusy(): boolean {
  return sending;
}

/**
 * One chat turn, whether it was typed or spoken: adds the question, waits for the
 * answer from `produce`, adds it to the log. Returns the answer's text, or null if
 * it failed (the island then shows the error in the note view).
 */
async function runTurn(shown: string, produce: () => Promise<string>): Promise<string | null> {
  if (!shown || sending) return null;
  sending = true;
  Sound.play("send");

  State.chatHistory.push({ id: nextId++, role: "user", content: shown });
  State.stateOverride = "thinking";
  State.notify();
  heightChanged();

  try {
    const reply = await produce();
    State.chatHistory.push({ id: nextId++, role: "assistant", content: reply });
    State.stateOverride = null;
    Sound.play("finish");
    return reply;
  } catch (err) {
    State.stateOverride = null;
    State.noteMessage = String(err).replace(/^Error:\s*/, "");
    State.view = "note";
    Sound.play("error");
    return null;
  } finally {
    sending = false;
    State.notify();
    heightChanged();
    focusInput();
  }
}

/**
 * A typed or spoken question. Alarms, e-mail and calendar are handled on the spot
 * (see assist/commands.ts); everything else goes to Claude.
 */
export function askClaude(query: string, opts: { spoken?: boolean } = {}): Promise<string | null> {
  const text = query.trim();
  return runTurn(text, async () => {
    const local = await handleLocalCommand(text);
    if (local !== null) return local;
    const file = State.droppedFile;
    const context: ChatContext | null =
      State.chatHistory.length === 1 && file ? { kind: "file", name: file.name, path: file.path } : null;
    const reply = await Bridge.chatSend(text, context, opts.spoken ?? false);
    return reply.text;
  });
}

/**
 * A question about what is on the screen, with a transcript of what was just
 * heard. An empty `query` means "work out what I need".
 */
export function askAboutScreen(query: string, heard: string): Promise<string | null> {
  const text = query.trim();
  return runTurn(text || "Look at my screen", () => Bridge.assistAsk(text, true, heard));
}

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const mic = h("button", { class: "mic-btn", title: "Talk" }, svg(ICONS.mic, 14, { stroke: 1.8 }));
  const bar = h("div", { class: "chat-bar" }, input, mic, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let renderedCount = -1;

  heightChanged = onHeightChange;
  focusInput = () => input.focus();

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    await askClaude(query);
  }

  send.addEventListener("click", () => void submit());
  mic.addEventListener("click", () => State.voiceToggle?.());
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount) {
        renderedCount = count;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      const phase = State.voicePhase;
      mic.style.display = State.settings.voiceEnabled ? "" : "none";
      mic.classList.toggle("on", phase === "listening");
      mic.classList.toggle("busy", phase === "transcribing" || phase === "thinking");
      mic.title =
        phase === "listening" ? "Stop and send" : phase === "speaking" ? "Stop talking" : "Talk";
      input.placeholder =
        phase === "listening" ? "Listening…"
        : phase === "transcribing" ? "Listening to what you said…"
        : phase === "speaking" ? "Speaking…"
        : State.chatHistory.length === 0 ? "Ask me anything…" : "Continue…";
      input.disabled = sending || phase === "listening" || phase === "transcribing";
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
