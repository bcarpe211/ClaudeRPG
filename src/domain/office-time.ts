const SEARCH_WINDOW_MS = 27 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

function assertEpochMs(now: number): void {
  if (!Number.isSafeInteger(now)) {
    throw new RangeError('now must be an integer epoch millisecond');
  }
}

export function officeDayKey(now: number, timeZone: string): string {
  assertEpochMs(now);
  const parts = formatter(timeZone).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) {
    throw new RangeError(`unable to resolve office day in ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

export function officeDayStart(now: number, timeZone: string): number {
  assertEpochMs(now);
  const currentKey = officeDayKey(now, timeZone);
  let outside = now - SEARCH_WINDOW_MS;
  let inside = now;
  if (officeDayKey(outside, timeZone) === currentKey) {
    throw new RangeError(`office day start exceeds search bounds in ${timeZone}`);
  }

  while (outside + 1 < inside) {
    const midpoint = Math.floor((outside + inside) / 2);
    if (officeDayKey(midpoint, timeZone) === currentKey) {
      inside = midpoint;
    } else {
      outside = midpoint;
    }
  }
  return inside;
}

export function nextOfficeMidnight(now: number, timeZone: string): number {
  assertEpochMs(now);
  const currentKey = officeDayKey(now, timeZone);
  let inside = now;
  let outside = now + SEARCH_WINDOW_MS;
  if (officeDayKey(outside, timeZone) === currentKey) {
    throw new RangeError(`next office midnight exceeds search bounds in ${timeZone}`);
  }

  while (inside + 1 < outside) {
    const midpoint = Math.floor((inside + outside) / 2);
    if (officeDayKey(midpoint, timeZone) === currentKey) {
      inside = midpoint;
    } else {
      outside = midpoint;
    }
  }
  return outside;
}
