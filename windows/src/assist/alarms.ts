// Alarms: understanding "wake me at 6:30" and ringing when one fires.
// The scheduling itself lives in Rust (alarms.rs); this file only parses what
// was said and plays the ring.

import type { AlarmRepeat } from "../core/bridge";

export interface AlarmRequest {
  label: string;
  at: Date;
  repeat: AlarmRepeat;
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, sixty: 60,
};

function amount(word: string): number | null {
  const w = word.toLowerCase();
  if (/^\d+(\.\d+)?$/.test(w)) return Number(w);
  return WORD_NUMBERS[w] ?? null;
}

/** "set an alarm for 6:30 am", "wake me up in 20 minutes", "remind me to call Ann at 5 pm". */
export function parseAlarm(text: string, now: Date = new Date()): AlarmRequest | null {
  const t = text.trim();
  if (!/\b(alarm|wake me|remind me|timer)\b/i.test(t)) return null;
  if (/\b(cancel|delete|remove|clear|stop|what|which|list|show)\b/i.test(t) && /\balarms?\b/i.test(t)) return null;

  let repeat: AlarmRepeat = "none";
  if (/\bweekdays?\b|\bmonday to friday\b/i.test(t)) repeat = "weekdays";
  else if (/\bevery (day|morning|night|evening)\b|\bdaily\b/i.test(t)) repeat = "daily";

  let at: Date | null = null;
  let timeText = "";

  // In 20 minutes / in an hour / in half an hour.
  const rel = t.match(/\b(?:in|for)\s+(half an?|\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|forty|sixty)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i);
  if (rel) {
    const half = /^half/i.test(rel[1]);
    const n = half ? 0.5 : amount(rel[1]);
    if (n == null) return null;
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith("s") ? 1000 : unit.startsWith("m") ? 60_000 : 3_600_000;
    at = new Date(now.getTime() + n * ms);
    timeText = rel[0];
  } else {
    const abs = t.match(/\b(?:at|for|by)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])(?!\s*(?:minutes?|mins?|hours?|hrs?|seconds?|secs?)\b)/i);
    if (!abs) return null;
    let hour = Number(abs[1]);
    const minute = abs[2] ? Number(abs[2]) : 0;
    const mer = abs[3]?.toLowerCase().replace(/\./g, "");
    if (minute > 59 || hour > 24 || (mer && hour > 12) || hour === 0 && mer) return null;
    const base = new Date(now);
    if (/\btomorrow\b/i.test(t)) base.setDate(base.getDate() + 1);
    const candidates: Date[] = [];
    const make = (h: number) => {
      const d = new Date(base);
      d.setHours(h % 24, minute, 0, 0);
      return d;
    };
    if (mer === "am") candidates.push(make(hour === 12 ? 0 : hour));
    else if (mer === "pm") candidates.push(make(hour === 12 ? 12 : hour + 12));
    else if (hour > 12 || hour === 0) candidates.push(make(hour));
    else candidates.push(make(hour === 12 ? 0 : hour), make(hour === 12 ? 12 : hour + 12)); // either half of the day
    // The soonest one that is still ahead; failing that, the same time tomorrow.
    const future = candidates.filter((d) => d.getTime() > now.getTime() + 1000).sort((a, b) => a.getTime() - b.getTime());
    at = future[0] ?? new Date(candidates[0].getTime() + 86_400_000);
    timeText = abs[0];
  }

  let label = "";
  const named = t.match(/\b(?:called|named|labell?ed|saying)\s+["“]?(.+?)["”]?\s*$/i);
  const remind = t.match(/\bremind me\b.*?\bto\s+(.+)$/i);
  if (named) label = named[1];
  else if (remind) label = remind[1];
  else {
    const to = t.match(/\balarm\b.*?\bto\s+(.+)$/i);
    if (to) label = to[1];
  }
  label = label
    .replace(timeText, " ")
    .replace(/\b(tomorrow|every (day|morning|night|evening)|daily|weekdays?|please)\b/gi, " ")
    .replace(/\b(at|in|for|by)\s*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.\-]+|[\s,.\-]+$/g, "")
    .replace(/^to\s+/i, "");
  if (!label) label = /\btimer\b/i.test(t) ? "Timer" : "Alarm";
  return { label: label.charAt(0).toUpperCase() + label.slice(1), at, repeat };
}

export type AlarmCommand = { kind: "list" } | { kind: "clear" } | { kind: "stop" };

export function parseAlarmCommand(text: string): AlarmCommand | null {
  const t = text.trim();
  if (/\b(cancel|delete|remove|clear)\b.*\balarms?\b/i.test(t)) return { kind: "clear" };
  if (/\b(what|which|list|show|any)\b.*\balarms?\b/i.test(t)) return { kind: "list" };
  if (/^\s*(stop|snooze|dismiss|silence)( the)?( alarm)?[.!]?\s*$/i.test(t)) return { kind: "stop" };
  return null;
}

/** "7:30 AM tomorrow", "in 20 minutes" — what a person wants to hear back. */
export function describeWhen(at: Date, now: Date = new Date()): string {
  const mins = Math.round((at.getTime() - now.getTime()) / 60_000);
  const clock = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = at.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86_400_000).toDateString() === at.toDateString();
  const day = sameDay ? "" : tomorrow ? " tomorrow" : ` on ${at.toLocaleDateString([], { weekday: "long" })}`;
  const within = mins < 1 ? "in under a minute" : mins < 60 ? `in ${mins} minute${mins === 1 ? "" : "s"}` : "";
  return within ? `${clock}${day}, ${within}` : `${clock}${day}`;
}
