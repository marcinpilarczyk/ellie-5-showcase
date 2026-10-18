/**
 * Minimal 5-field cron evaluator (minute hour day-of-month month day-of-week)
 * evaluated in a named IANA timezone. Supports *, lists, ranges and steps.
 * Day-of-week: 0 or 7 = Sunday.
 */

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domWild: boolean;
  dowWild: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step in '${field}'`);

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = parseInt(rangePart, 10);
      hi = stepPart ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron field '${field}'`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression must have 5 fields: '${expr}'`);
  const dow = parseField(fields[4], 0, 7);
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dom: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dow,
    domWild: fields[2] === '*',
    dowWild: fields[4] === '*'
  };
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getZonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short'
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    dow: WEEKDAYS[parts.weekday]
  };
}

function matches(cron: ParsedCron, date: Date, timeZone: string): boolean {
  const p = getZonedParts(date, timeZone);
  if (!cron.minute.has(p.minute) || !cron.hour.has(p.hour) || !cron.month.has(p.month)) return false;
  const domOk = cron.dom.has(p.day);
  const dowOk = cron.dow.has(p.dow);
  if (!cron.domWild && !cron.dowWild) return domOk || dowOk;
  return domOk && dowOk;
}

export function lastFireTime(
  expr: string,
  now: Date,
  timeZone: string = 'Europe/Warsaw',
  lookbackMinutes: number = 24 * 60
): Date | null {
  const cron = parseCron(expr);
  const start = new Date(Math.floor(now.getTime() / 60000) * 60000);
  for (let i = 0; i <= lookbackMinutes; i++) {
    const candidate = new Date(start.getTime() - i * 60000);
    if (matches(cron, candidate, timeZone)) return candidate;
  }
  return null;
}

/** Latest scheduled cron slot at or before `now` (within `lookbackMinutes`), for per-slot deduplication. */
export function latestScheduledSlotAtOrBefore(
  expr: string,
  now: Date,
  timeZone: string = 'Europe/Warsaw',
  lookbackMinutes: number = 24 * 60
): Date | null {
  return lastFireTime(expr, now, timeZone, lookbackMinutes);
}

export function zonedDateKey(date: Date, timeZone: string = 'Europe/Warsaw'): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function nextFireTime(
  expr: string,
  now: Date,
  timeZone: string = 'Europe/Warsaw',
  lookaheadMinutes: number = 14 * 24 * 60
): Date | null {
  const cron = parseCron(expr);
  const start = new Date(Math.floor(now.getTime() / 60000) * 60000);
  for (let i = 1; i <= lookaheadMinutes; i++) {
    const candidate = new Date(start.getTime() + i * 60000);
    if (matches(cron, candidate, timeZone)) return candidate;
  }
  return null;
}
