const months = 'january february march april may june july august september october november december'.split(' ');
const weekdays = 'sunday monday tuesday wednesday thursday friday saturday'.split(' ');
const monthPattern = months.map(name => `${name.slice(0, 3)}(?:${name.slice(3)})?`).join('|');
const dayNumber = '(\\d{1,2})(?:st|nd|rd|th)?';
const writtenDate = new RegExp(`\\b(?:${dayNumber}\\s+(?:of\\s+)?(${monthPattern})|(${monthPattern})\\s+${dayNumber})(?:[ ,]+(\\d{4}))?\\b`, 'gi');
const dayFormatters = new Map();
const calendarFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});

export function timeZoneOrUtc(value) {
  if (typeof value !== 'string' || value.length > 80) return 'UTC';
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export function localDay(time, timeZone) {
  if (!dayFormatters.has(timeZone)) {
    dayFormatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }));
  }
  const parts = Object.fromEntries(dayFormatters.get(timeZone).formatToParts(time).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function midnightUtc(day) {
  return Date.parse(`${day}T00:00:00Z`);
}

export function addDays(day, count) {
  const date = new Date(midnightUtc(day));
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function validDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(midnightUtc(day)) && new Date(midnightUtc(day)).toISOString().slice(0, 10) === day;
}

export function formatCalendarDay(day) {
  return calendarFormatter.format(midnightUtc(day));
}

// Find the first instant belonging to this local day. A local day can be 23 or 25 hours.
function firstInstant(day, timeZone) {
  const center = midnightUtc(day);
  let before = center - 86_400_000;
  let after = center + 86_400_000;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (localDay(middle, timeZone) < day) before = middle;
    else after = middle;
  }
  return after;
}

export function dateRanges(text, now, timeZone) {
  const today = localDay(now, timeZone);
  const ranges = [];
  const add = (start, end, phrase) => {
    if (!validDay(start) || !validDay(end) || ranges.some(range => range.start === start && range.end === end)) return;
    ranges.push({ start, end, phrase, from: firstInstant(start, timeZone), until: firstInstant(end, timeZone) });
  };
  const addDay = (day, phrase) => {
    if (validDay(day)) add(day, addDays(day, 1), phrase);
  };

  for (const [phrase] of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) addDay(phrase, phrase);
  for (const [phrase, firstDay, firstMonth, secondMonth, secondDay, year] of text.matchAll(writtenDate)) {
    const month = months.findIndex(name => name.startsWith((firstMonth ?? secondMonth).toLowerCase())) + 1;
    const monthDay = `${String(month).padStart(2, '0')}-${(firstDay ?? secondDay).padStart(2, '0')}`;
    let day = `${year ?? today.slice(0, 4)}-${monthDay}`;
    if (!year && day > today) day = `${Number(today.slice(0, 4)) - 1}-${monthDay}`;
    addDay(day, phrase);
  }

  const weekday = new Date(midnightUtc(today)).getUTCDay();
  const monday = addDays(today, -((weekday + 6) % 7));
  for (const [phrase, modifier, name] of text.matchAll(/\b(?:(last|this|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi)) {
    const target = weekdays.indexOf(name.toLowerCase());
    const offset = (weekday - target + 7) % 7;
    if (modifier?.toLowerCase() === 'this') addDay(addDays(monday, (target + 6) % 7), phrase);
    else if (modifier?.toLowerCase() === 'last') {
      addDay(addDays(today, -(offset || 7)), phrase);
      addDay(addDays(monday, (target + 6) % 7 - 7), phrase);
    } else addDay(addDays(today, -offset), phrase);
  }
  if (/\byesterday\b/i.test(text)) addDay(addDays(today, -1), 'yesterday');
  if (/\btoday\b/i.test(text)) addDay(today, 'today');
  if (/\btomorrow\b/i.test(text)) addDay(addDays(today, 1), 'tomorrow');
  if (/\blast week\b/i.test(text)) add(addDays(monday, -7), monday, 'last week');
  for (const [phrase, count] of text.matchAll(/\b(\d{1,3}) days? ago\b/gi)) addDay(addDays(today, -Number(count)), phrase);
  return ranges.slice(0, 8);
}
