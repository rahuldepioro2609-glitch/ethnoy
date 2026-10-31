export const DEFAULT_EXAM_TIME_ZONE = 'Asia/Kolkata';

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function currentDateInTimeZone(now: Date, timeZone: string): string {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Invalid IANA time zone: ${timeZone}`);
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isRegistrationOpen(
  registrationStart: string,
  registrationEnd: string,
  timeZone: string,
  now: Date = new Date(),
): boolean {
  const today = currentDateInTimeZone(now, timeZone);
  return registrationStart <= today && today <= registrationEnd;
}

export function getDateOnlyParts(value: string, locale = 'en'): { day: string; month: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Invalid calendar date: ${value}`);
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) {
    throw new RangeError(`Invalid calendar date: ${value}`);
  }
  return {
    day,
    month: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date).toLocaleUpperCase(locale),
  };
}
