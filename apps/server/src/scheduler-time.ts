const FALLBACK_TIME_ZONE = "Asia/Shanghai";

/** The host's own IANA zone; scheduled jobs default here instead of a hardcoded region. */
export function systemSchedulerTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && isSupportedTimeZone(zone)) return zone;
  } catch {
    // fall through to the fixed fallback
  }
  return FALLBACK_TIME_ZONE;
}
export const SCHEDULE_TEMPLATE_IDS = ["weekly-application-review", "daily-application-plan"] as const;

export type ScheduleTemplateId = (typeof SCHEDULE_TEMPLATE_IDS)[number];

export const SCHEDULE_TEMPLATE_CRONS: Readonly<Record<ScheduleTemplateId, string>> = {
  "weekly-application-review": "0 8 * * 1",
  "daily-application-plan": "0 8 * * *"
};

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Both registered templates fire at 08:00 wall-clock time in the job's own zone. */
const SCHEDULED_HOUR = 8;
const MONDAY = 1;
/** A weekly template needs at most seven forward steps, plus one for "today already fired". */
const MAX_DAY_STEPS = 8;

export function isScheduleTemplateId(value: string): value is ScheduleTemplateId {
  return (SCHEDULE_TEMPLATE_IDS as readonly string[]).includes(value);
}

const timeZoneSupport = new Map<string, boolean>();

/** True when the runtime's ICU data knows this IANA zone. */
export function isSupportedTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const cached = timeZoneSupport.get(value);
  if (cached !== undefined) return cached;
  let supported: boolean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    supported = true;
  } catch {
    supported = false;
  }
  timeZoneSupport.set(value, supported);
  return supported;
}

export function assertSupportedTimeZone(value: unknown): string {
  if (!isSupportedTimeZone(value)) throw new Error(`Unsupported IANA time zone: ${String(value)}`);
  return value;
}

/** Persisted rows are never trusted to keep the scheduler loop alive on a bad zone. */
function resolveTimeZone(value: unknown): string {
  return isSupportedTimeZone(value) ? value : systemSchedulerTimeZone();
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

interface ZonedParts extends CivilDate {
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock fields of `instant` as seen in `timeZone`. */
function zonedParts(instant: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Some ICU builds render midnight as "24"; normalise it back to hour 0 of the same day.
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second")
  };
}

function civilDate(instant: number, timeZone: string): CivilDate {
  const { year, month, day } = zonedParts(instant, timeZone);
  return { year, month, day };
}

function addDays(date: CivilDate, amount: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Weekday of a civil date. A calendar date names the same weekday in every zone. */
function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function sameCivilDate(left: CivilDate, right: CivilDate): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

/** Zone offset east of UTC, in milliseconds, at `instant`. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant / 1_000) * 1_000;
}

/**
 * The UTC instant whose wall clock in `timeZone` is `date` at `hour`:00.
 * Guess with the offset in force at the same nominal UTC time, then correct once with the
 * offset actually in force at the guessed instant — the standard two-step that lands on the
 * right side of a DST transition. When the wall time does not exist (spring-forward gap), the
 * uncorrected guess is kept, which shifts the run forward by the size of the gap.
 */
function instantAtWallClock(date: CivilDate, hour: number, timeZone: string): number {
  const nominal = Date.UTC(date.year, date.month - 1, date.day, hour);
  const firstOffset = zoneOffsetMs(nominal, timeZone);
  const candidate = nominal - firstOffset;
  const secondOffset = zoneOffsetMs(candidate, timeZone);
  if (secondOffset === firstOffset) return candidate;
  const corrected = nominal - secondOffset;
  const parts = zonedParts(corrected, timeZone);
  return sameCivilDate(parts, date) && parts.hour === hour ? corrected : candidate;
}

/** First instant strictly after `after` whose wall clock in `timeZone` matches the template. */
export function zonedNext(templateId: ScheduleTemplateId, after: number, timeZone: string): number {
  const zone = resolveTimeZone(timeZone);
  const weekly = templateId === "weekly-application-review";
  let date = civilDate(after, zone);
  for (let step = 0; step <= MAX_DAY_STEPS; step += 1) {
    if (!weekly || weekdayOf(date) === MONDAY) {
      const instant = instantAtWallClock(date, SCHEDULED_HOUR, zone);
      if (instant > after) return instant;
    }
    date = addDays(date, 1);
  }
  throw new Error(`Unable to compute the next ${templateId} instant in ${zone}`);
}

/** Last instant at or before `at` whose wall clock in `timeZone` matches the template. */
export function zonedLatest(templateId: ScheduleTemplateId, at: number, timeZone: string): number {
  const zone = resolveTimeZone(timeZone);
  const weekly = templateId === "weekly-application-review";
  let date = civilDate(at, zone);
  for (let step = 0; step <= MAX_DAY_STEPS; step += 1) {
    if (!weekly || weekdayOf(date) === MONDAY) {
      const instant = instantAtWallClock(date, SCHEDULED_HOUR, zone);
      if (instant <= at) return instant;
    }
    date = addDays(date, -1);
  }
  throw new Error(`Unable to compute the previous ${templateId} instant in ${zone}`);
}

export function nextScheduledAt(
  templateId: ScheduleTemplateId,
  after: number,
  timeZone: string = systemSchedulerTimeZone()
): number {
  return zonedNext(templateId, after, timeZone);
}

/** Returns the most recent scheduled instant at or before `at`, or null. */
export function latestScheduledAt(
  templateId: ScheduleTemplateId,
  firstScheduledAt: number,
  at: number,
  timeZone: string = systemSchedulerTimeZone()
): number | null {
  if (firstScheduledAt > at) return null;
  return zonedLatest(templateId, at, timeZone);
}

/**
 * Number of template periods represented by a merged run, inclusive.
 * Fixed periods are good enough: a DST transition moves the span by at most one hour, which
 * rounding absorbs for both a 24-hour and a 7-day period.
 */
export function mergedScheduleCount(
  templateId: ScheduleTemplateId,
  firstScheduledAt: number,
  latestAt: number
): number {
  const period = templateId === "daily-application-plan" ? DAY_MS : 7 * DAY_MS;
  return Math.max(1, Math.round((latestAt - firstScheduledAt) / period) + 1);
}
