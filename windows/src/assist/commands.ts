// Things Jimmy does on the spot, without a round trip to Claude: alarms, reading
// e-mail and the calendar, and looking at the screen for WhatsApp and Instagram.
// `handleLocalCommand` returns the reply text, or null when the request is not one
// of these and should go to Claude as usual.

import { Bridge, type Alarm, type CalEvent, type Mail } from "../core/bridge";
import { describeWhen, parseAlarm, parseAlarmCommand } from "./alarms";
import { stopRinging } from "./ringer";

export async function handleLocalCommand(text: string): Promise<string | null> {
  const t = text.trim();
  if (!t) return null;

  // ── Alarms ────────────────────────────────────────────────────────────────
  const cmd = parseAlarmCommand(t);
  if (cmd?.kind === "stop") return stopRinging() ? "Alarm stopped." : null;
  if (cmd?.kind === "list") return describeAlarms((await Bridge.alarmList()) ?? []);
  if (cmd?.kind === "clear") {
    const n = await Bridge.alarmRemove();
    return n ? `Cancelled ${n} alarm${n === 1 ? "" : "s"}.` : "You have no alarms set.";
  }
  const alarm = parseAlarm(t);
  if (alarm) {
    const saved = await Bridge.alarmAdd(alarm.label, alarm.at.getTime(), alarm.repeat);
    const again = saved.repeat === "daily" ? ", every day" : saved.repeat === "weekdays" ? ", on weekdays" : "";
    return `Set: ${saved.label}, at ${describeWhen(alarm.at)}${again}.`;
  }

  // ── Screen: whatever is open (WhatsApp Web, Instagram, a page, a document) ─
  if (wantsScreen(t)) {
    return Bridge.assistAsk(t, true, "");
  }
  if (/\b(read|check|any|new|open)\b.*\b(whats\s?app|instagram|insta)\b|\b(whats\s?app|instagram|insta)\b.*\b(messages?|dms?|chats?)\b/i.test(t)) {
    return Bridge.assistAsk(
      `${t}\n\nYou can only see what is on the screen. Summarise the messages that are visible and who they are from. ` +
        "If WhatsApp or Instagram is not open on the screen, say so and tell the user to open it (the web versions work) and ask again.",
      true,
      "",
    );
  }

  // ── Mail and calendar ─────────────────────────────────────────────────────
  if (/\b(read|check|any|new|unread|summari[sz]e|what)\b.*\b(e-?mails?|inbox|gmail|mail)\b/i.test(t)) {
    return needGoogle(async () => summarise(t, "e-mail", formatMail(await Bridge.googleUnread(8))));
  }
  if (/\b(what|read|check|show|any|do i have)\b.*\b(calendar|agenda|meetings?|events?|schedule|appointments?)\b/i.test(t)) {
    const { from, to, label } = calendarWindow(t);
    return needGoogle(async () => summarise(t, `calendar (${label})`, formatEvents(await Bridge.googleEvents(from, to))));
  }
  if (/\b(read|check|any|new)\b.*\bmessages?\b/i.test(t)) {
    return needGoogle(async () => summarise(t, "e-mail", formatMail(await Bridge.googleUnread(8))));
  }
  return null;
}

function wantsScreen(t: string): boolean {
  return /\b(read|look at|see|check|what'?s on|what is on|describe|scan)\b.*\b(my |the )?(screen|display|monitor)\b/i.test(t);
}

async function needGoogle(run: () => Promise<string>): Promise<string> {
  const status = await Bridge.googleStatus();
  if (!status?.connected) {
    return status?.configured
      ? "Google isn't connected yet. Open Settings → Connections and press Connect."
      : "To read your e-mail and calendar, add your Google client ID and secret in Settings → Connections, then press Connect.";
  }
  return run();
}

/** Short, speakable summary of fetched data; falls back to the plain list. */
async function summarise(request: string, what: string, data: string): Promise<string> {
  if (!data.trim()) return `Nothing new in your ${what}.`;
  try {
    return await Bridge.assistAsk(
      `The user asked: "${request}"\nHere is their ${what}:\n${data}\n\nAnswer in a few short spoken-style sentences: say how many items there are, ` +
        "then the important ones first (who, what, when). Do not read out web addresses.",
      false,
      "",
    );
  } catch {
    return data;
  }
}

export function formatMail(mails: Mail[]): string {
  return mails
    .map((m, i) => `${i + 1}. From ${m.from.replace(/<.*>/, "").trim() || "unknown"} — ${m.subject || "(no subject)"} — ${m.snippet}`)
    .join("\n");
}

export function formatEvents(events: CalEvent[]): string {
  return events
    .map((e) => {
      const start = e.start.includes("T") ? new Date(e.start).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : `${e.start} (all day)`;
      return `- ${start}: ${e.title}${e.location ? ` at ${e.location}` : ""}`;
    })
    .join("\n");
}

/** "today", "tomorrow", otherwise the next 7 days. */
export function calendarWindow(t: string, now: Date = new Date()): { from: string; to: string; label: string } {
  const start = new Date(now);
  const end = new Date(now);
  if (/\btomorrow\b/i.test(t)) {
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    end.setTime(start.getTime() + 86_400_000);
    return { from: start.toISOString(), to: end.toISOString(), label: "tomorrow" };
  }
  if (/\btoday\b|\btonight\b/i.test(t)) {
    end.setHours(24, 0, 0, 0);
    return { from: now.toISOString(), to: end.toISOString(), label: "today" };
  }
  end.setDate(end.getDate() + 7);
  return { from: now.toISOString(), to: end.toISOString(), label: "next 7 days" };
}

function describeAlarms(list: Alarm[]): string {
  if (!list.length) return "You have no alarms set.";
  return list
    .map((a) => `${a.label}: ${describeWhen(new Date(a.atMs))}${a.repeat === "none" ? "" : ` (${a.repeat})`}`)
    .join("\n");
}
