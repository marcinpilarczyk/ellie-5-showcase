/** The owner's timezone (ELLIE_TIMEZONE). Every run is told the current local time in it. */
export const OWNER_TIMEZONE = process.env.ELLIE_TIMEZONE?.trim() || 'Europe/Warsaw';

function offsetMs(at: Date, timeZone: string): number {
  const parts: Record<string, number> = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  for (const p of fmt.formatToParts(at)) if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function formatOffset(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const minutes = Math.abs(ms) / 60000;
  return `${sign}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Local midnight of a YYYY-MM-DD date in the given timezone, as a UTC Date. */
export function zonedMidnight(date: string, timeZone = OWNER_TIMEZONE): Date {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Expected a date as YYYY-MM-DD, got "${date}"`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const first = guess - offsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

/** [start, end) of `days` whole local days starting at `date`. */
export function zonedDayRange(date: string, days = 1, timeZone = OWNER_TIMEZONE): { timeMin: string; timeMax: string } {
  const start = zonedMidnight(date, timeZone);
  const next = new Date(start.getTime() + days * 86_400_000 + 12 * 3_600_000); // land inside the target day despite DST
  const endDate = new Intl.DateTimeFormat('en-CA', { timeZone }).format(next);
  return { timeMin: start.toISOString(), timeMax: zonedMidnight(endDate, timeZone).toISOString() };
}

/** One line for the start of every run: the model has no clock of its own. */
export function nowLine(now = new Date(), timeZone = OWNER_TIMEZONE): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  const human = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(now);
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(zonedMidnight(date, timeZone).getTime() + 36 * 3_600_000));
  return `[Now: ${human} (${date}, ${timeZone}, UTC${formatOffset(offsetMs(now, timeZone))}). Tomorrow is ${tomorrow}.]`;
}
