const normalized = value => value.trim().toLowerCase().replace(/\s+/g, ' ');
const unknown = value => !value || /^(?:unknown|unclear|n\/a|unspecified)$/i.test(value.trim());
const symbols = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', CAD: 'CA$', AUD: 'A$' };
const periods = { seat_month: '/seat/month', seat_year: '/seat/year', account_month: '/month', account_year: '/year', other: '' };
const commitments = { monthly: 'month to month', annual: 'billed annually', usage: 'usage based', other: 'see terms', unknown: 'billing unknown' };

function quotedCommitment(quote) {
  const monthly = /\b(?:(?:billed|paid|pay) monthly|monthly (?:billing|commitment|contract)|month[- ]to[- ]month)\b/i.test(quote);
  const annual = /\b(?:(?:billed|paid|pay) (?:annually|yearly)|(?:annual|yearly) (?:billing|commitment|contract))\b/i.test(quote);
  if (monthly === annual) return 'unknown';
  return monthly ? 'monthly' : 'annual';
}

function currencyDigits(currency) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
}

export function validPrice(price, web, evidence = null) {
  const source = web.get(price.source);
  if (!source || !price.entity.trim() || !price.plan.trim() || !/^[A-Z]{3}$/.test(price.currency) ||
      (price.minSeats !== null && (price.minSeats < 0 || price.minSeats > 1e6))) return null;
  const quote = (evidence?.quote ?? price.quote).trim().replace(/\s+/g, ' ');
  if (quote.length < 5 || quote.length > 480 || !source.passage.replace(/\s+/g, ' ').includes(quote)) return null;
  const quotedBilling = quotedCommitment(quote);
  const modelBilling = ['monthly', 'annual'].includes(price.commitment);
  const commitment = evidence || modelBilling ? quotedBilling : price.commitment;
  if (!evidence && quotedBilling !== 'unknown' && modelBilling && quotedBilling !== price.commitment) return null;
  const aliases = { USD: ['US$', '$'], CAD: ['CA$', 'C$'], AUD: ['AU$', 'A$'] };
  const markers = [price.currency, ...(aliases[price.currency] ?? [symbols[price.currency]].filter(Boolean))];
  const marker = markers.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const number = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
  const prefix = `(?:${marker})[\\s*_]*${number}(?!\\d|[.,]\\d)`;
  const suffix = `${number}\\s*${price.currency}\\b`;
  const scale = 10 ** currencyDigits(price.currency);
  const pattern = new RegExp(evidence ? `^(?:${prefix}|${suffix})$` : `(?<![A-Z])${prefix}|${suffix}`, 'gi');
  const amounts = [...(evidence?.amount ?? quote).matchAll(pattern)].map(match => Math.round(Number((match[1] ?? match[2]).replace(/,/g, '')) * scale));
  const minor = evidence ? amounts[0] : price.minor;
  if (!amounts.includes(minor) || minor < 0 || minor > 1e12 || (evidence && !normalized(quote).includes(normalized(price.plan)))) return null;
  return { entity: price.entity.trim().slice(0, 100), plan: price.plan.trim().slice(0, 100), currency: price.currency,
    minor, unit: price.unit, commitment, region: price.region.trim().slice(0, 70),
    minSeats: price.minSeats, terms: price.terms.trim().slice(0, 160), sourceId: source.id, quote };
}

function priceKey(price) {
  if (unknown(price.region) || unknown(price.terms) || price.minSeats === null || price.unit === 'other' ||
      ['unknown', 'other', 'usage'].includes(price.commitment) || quotedCommitment(price.quote) !== price.commitment) return null;
  return [price.entity, price.plan, price.currency, price.unit, price.commitment, price.region, String(price.minSeats), price.terms]
    .map(normalized).join('\u001f');
}

function displayPrice(price) {
  const amount = price.minor / 10 ** currencyDigits(price.currency);
  const number = new Intl.NumberFormat('en', { style: 'currency', currency: price.currency, currencyDisplay: 'code' }).format(amount);
  return `${number}${periods[price.unit]} (${commitments[price.commitment]})`;
}

export function comparePrices(entity, before, after, sources) {
  const matches = list => list.filter(price => normalized(price.entity) === normalized(entity));
  const previous = matches(before).filter(price => sources.has(price.sourceId));
  const current = matches(after).filter(price => sources.has(price.sourceId));
  if (!current.length) return { text: 'Current price unverified', sourceIds: [] };
  const eligible = current.filter(price => sources.get(price.sourceId).fetch_mode !== 'provider_default');
  const pairs = new Map();
  for (const latest of eligible) {
    const key = priceKey(latest);
    if (!key) continue;
    for (const old of previous.filter(price => priceKey(price) === key)) {
      const variants = pairs.get(key) ?? new Map();
      variants.set(`${old.minor}/${latest.minor}`, { old, latest });
      pairs.set(key, variants);
    }
  }
  const observations = [];
  const sourceIds = [];
  for (const variants of pairs.values()) {
    if (variants.size > 1) {
      observations.push('Conflicting observations for a comparable plan');
      for (const { old, latest } of variants.values()) sourceIds.push(old.sourceId, latest.sourceId);
      continue;
    }
    const { old, latest } = variants.values().next().value;
    sourceIds.push(old.sourceId, latest.sourceId);
    observations.push(old.minor === latest.minor
      ? `${latest.plan}: same at both checks (${displayPrice(latest)})`
      : `${latest.plan}: ${displayPrice(old)} → ${displayPrice(latest)} at the two checks`);
  }
  if (observations.length) return { text: observations.join('\n'), sourceIds: [...new Set(sourceIds)] };
  const latest = current[0];
  const freshness = sources.get(latest.sourceId).fetch_mode === 'provider_default' ? 'Search result, freshness unconfirmed' : 'Price found';
  return { text: `${freshness}: ${latest.plan} at ${displayPrice(latest)}. ${previous.length ? 'No comparable plan terms.' : 'Earlier comparable price unavailable.'}`,
    sourceIds: [latest.sourceId] };
}
