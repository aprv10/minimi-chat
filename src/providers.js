const string = { type: 'string' };
const integer = { type: 'integer' };
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const array = items => ({ type: 'array', items });
const choice = (...values) => ({ type: 'string', enum: values });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const emptyAction = {
  action: 'answer', baseline: '', shortlistRef: '', historyQueries: [], queries: [], blocks: [], coverage: [], shortlist: null, prices: [],
};

export const responseSchema = object({
  action: choice('web_search', 'answer', 'clarify'),
  baseline: string,
  shortlistRef: string,
  historyQueries: array(string),
  queries: array(object({ query: string, item: string, focus: choice('current', 'timeline', 'lookup'), since: string, domains: array(string), page: string })),
  blocks: array(object({ text: string, refs: array(string) })),
  coverage: array(object({ item: string, release: string, eventDay: string, quote: string, refs: array(string) })),
  shortlist: nullable(object({ label: string, items: array(string), criteria: array(string), replaces: string })),
  prices: array(object({
    entity: string, plan: string, currency: string, minor: integer,
    unit: choice('seat_month', 'seat_year', 'account_month', 'account_year', 'other'),
    commitment: choice('monthly', 'annual', 'usage', 'other', 'unknown'),
    region: string, minSeats: nullable(integer), terms: string, source: string, evidence: string, quote: string,
  })),
});

export const finalResponseSchema = object({ ...responseSchema.properties, action: choice('answer', 'clarify') });

export function conforms(value, schema = responseSchema) {
  if (schema.anyOf) return schema.anyOf.some(option => conforms(value, option));
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === 'null') return value === null;
  if (schema.type === 'integer') return Number.isSafeInteger(value);
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'array') return Array.isArray(value) && value.every(item => conforms(item, schema.items));
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === schema.required.length &&
    schema.required.every(key => Object.hasOwn(value, key) && conforms(value[key], schema.properties[key]));
}

export class ProviderError extends Error {
  constructor(provider, status) {
    super(`${provider} returned HTTP ${status}`);
    this.provider = provider;
    this.status = status;
  }
}

export function providerIssue(error, provider) {
  if (error?.name === 'TimeoutError') return `${provider} timed out`;
  if (error instanceof ProviderError) {
    if ([401, 403].includes(error.status)) return `${provider} rejected the API key or model access`;
    if ([429, 432, 433].includes(error.status)) return `${provider} usage limit reached`;
    if (error.status === 434) return `${provider} could not fetch fresh pages on this plan`;
    return `${provider} returned HTTP ${error.status}`;
  }
  return `${provider} could not complete the request`;
}

export function safeWebUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function matchesDomain(url, domains) {
  const host = new URL(url).hostname.toLowerCase();
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

export function isPricingLookup(job) {
  return job.focus === 'current' && /\b(?:pric\w*|cost\w*|bill\w*|plans?)\b/i.test(job.query);
}

export function pricingPageRank(source, job) {
  const url = new URL(source.url);
  const brand = job.item.toLowerCase().match(/[a-z0-9]+/g)?.[0];
  const knownHost = matchesDomain(source.url, job.domains ?? []);
  const labels = url.hostname.toLowerCase().split('.');
  const suffix = labels.at(-1)?.length === 2 && /^(?:co|com|org|net)$/.test(labels.at(-2)) ? 2 : 1;
  const namedHost = brand?.length >= 3 && labels.at(-(suffix + 1)) === brand;
  if ((!knownHost && !namedHost) || url.port) return 0;
  const path = /(?:^|[/-])(?:pricing|prices|plans|cost)(?:[./_-]|$)/i.test(url.pathname);
  const title = /\b(?:pricing|prices|plans|cost)\b/i.test(source.title);
  if (!path && !title) return 0;
  if (/\/(?:blog|reviews?|compare|[a-z-]*comparison|community|partners?)(?:\/|$)/i.test(url.pathname)) return 0;
  const supportingPage = /^(?:blog|docs|help|support)\./i.test(url.hostname) || /(?:calculator|estimate|\/articles?\/)/i.test(url.pathname);
  const productWords = job.item.toLowerCase().match(/[a-z0-9]+/g)?.slice(1).filter(word => word.length > 3) ?? [];
  const productPath = productWords.some(word => url.pathname.toLowerCase().split(/[\W_]+/).includes(word));
  return (knownHost ? 4 : 0) + (path ? 3 : 1) + (supportingPage ? 0 : 4 + Number(productPath) * 2);
}

export function pricingPageToRead(source, job) {
  const { url, title, published_day, query } = source;
  const { hostname, pathname } = new URL(url);
  const vendor = job.domains.filter(domain => matchesDomain(url, [domain])).sort((a, b) => a.length - b.length)[0];
  const suggested = safeWebUrl(job.page);
  if (vendor && suggested && matchesDomain(suggested, [vendor])) {
    const candidate = { url: suggested, title: '', published_day: null, query };
    const address = new URL(suggested);
    if (!address.search && !address.hash && pricingPageRank(candidate, job) > pricingPageRank(source, job)) {
      return { ...candidate, title: `${job.item} pricing`, vendor };
    }
  }
  if (pricingPageRank(source, job) <= 7 && vendor && vendor !== hostname) {
    const locale = pathname.match(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i)?.[0] ?? '';
    return { url: `https://www.${vendor}${locale}/pricing`, title: `${job.item} pricing`, published_day: null, query, vendor };
  }
  return { url, title, published_day, query };
}

async function post(url, key, data, signal, provider) {
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    if (provider === 'Groq' && response.status === 400) {
      const body = await response.json().catch(() => null);
      if (body?.error?.code === 'json_validate_failed') return { failedGeneration: body.error.failed_generation ?? '' };
    } else await response.body?.cancel();
    throw new ProviderError(provider, response.status);
  }
  return response.json();
}

function bestPagePassage(raw, snippet, query) {
  if (!raw) return snippet.slice(0, 1700);
  const terms = (query.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, 15);
  const lines = raw.slice(0, 140_000).split('\n').map(line => line.trim()).filter(Boolean);
  const groups = [];
  for (let index = 0; index < lines.length; index += 3) {
    const text = lines.slice(Math.max(0, index - 2), index + 5).join('\n').slice(0, 850);
    const lower = text.toLowerCase();
    const score = terms.filter(term => lower.includes(term)).length + (/[€£$₹]\s*\d|\b(?:USD|EUR|GBP|INR)\b/.test(text) ? 2 : 0);
    groups.push({ text, score });
  }
  groups.sort((a, b) => b.score - a.score);
  return [...new Set([...groups.slice(0, 2).map(group => group.text), snippet.slice(0, 550)])].filter(Boolean).join('\n\n').slice(0, 2050);
}

const money = /(?:(?:US|CA|AU|A|C)?\$|[€£₹¥]|\b(?:USD|EUR|GBP|INR|CAD|AUD|JPY)\b)[\s*_]*\d(?:[\d.,]*\d)?|\b\d(?:[\d.,]*\d)?\s*(?:USD|EUR|GBP|INR|CAD|AUD|JPY)\b/gi;

export function pricingEvidence(passage) {
  return passage.split('\n\n---\n\n').flatMap(section => [...section.matchAll(money)].map(match => ({
    amount: match[0], quote: section.slice(Math.max(0, match.index - 120), match.index + match[0].length + 105).trim(),
  }))).slice(0, 8).map((evidence, index) => ({ id: `E${index + 1}`, ...evidence }));
}

export function listedPlanPrices(passage) {
  const prices = new Map();
  const priceUnit = /^\s*(?:(?:per\s+|\/\s*)(?:seat|user)\s*)?(?:per\s+|\/\s*)(?:month|mo|year|yr)\b(?:\s*\/\s*(?:seat|user)\b)?/i;
  for (const section of passage.split('\n\n---\n\n')) {
    collectListedPrices(section, prices, priceUnit);
  }
  return [...prices].slice(0, 2).map(([plan, { options, quotes }]) => ({
    text: `${plan} ${[...options].join(' or ')}${options.size > 1 ? ' (check billing and eligibility)' : ''}`,
    quote: [...quotes].join('\n\n'),
  }));
}

function collectListedPrices(passage, prices, priceUnit) {
  const headings = [...passage.matchAll(/^#{2,5}\s+([^\n]+)$/gm)];
  for (const line of passage.matchAll(/^[ \t]*[^\n]+$/gm)) {
    const amounts = [...line[0].matchAll(money)];
    if (!amounts.length || line[0].slice(0, amounts[0].index).trim()) continue;
    const terms = amounts.map((amount, index) => line[0].slice(amount.index + amount[0].length, amounts[index + 1]?.index));
    const end = line.index + line[0].length;
    if (amounts.length === 1 && !terms[0].trim()) {
      const adjacent = passage.slice(end).match(/^\n+(?:One payment of [^\n]+\n+)?(Per (?:seat|user) per (?:month|year)[^\n]*)/i);
      const label = passage.slice(0, line.index).match(/(?:^|\n)([\p{L}\d][\p{L}\d &+–-]{0,36})\n+[^\n]{15,130}\n+$/u);
      if (adjacent && label && !label[0].match(money)) {
        addListedPrice(prices, label[1], [amounts[0][0] + ' ' + adjacent[1]], passage.slice(label.index, end + adjacent[0].length).trim());
      }
      continue;
    }
    if (terms.some(term => !priceUnit.test(term))) continue;
    const before = headings.findLast(heading => heading.index < line.index);
    const after = headings.find(heading => heading.index >= end);
    const adjacent = after && /^\s*$/.test(passage.slice(end, after.index));
    const heading = adjacent ? after : before && line.index - before.index < 130 ? before : null;
    const plan = heading?.[1].trim();
    if (!plan || !/^[\p{L}\d][\p{L}\d &+–-]{0,36}$/u.test(plan) || /\b(?:pricing|save|addons?|add-ons?|faq|plans)\b/i.test(plan)) continue;
    const quote = passage.slice(Math.min(line.index, heading.index), Math.max(end, heading.index + heading[0].length)).trim();
    if (quote.length > 350) continue;
    const options = terms.map((term, index) => {
      const period = term.match(priceUnit)[0].trim();
      const billing = term.match(/\b[Bb]illed (?:annually|monthly)(?=\b|[A-Z])/)?.[0];
      const unit = period.startsWith('/') ? period : ` ${period}`;
      return `${amounts[index][0]}${unit}${billing ? `, ${billing}` : ''}`;
    });
    addListedPrice(prices, plan, options, quote);
  }
}

function addListedPrice(prices, plan, options, quote) {
  const listed = prices.get(plan) ?? { options: new Set(), quotes: new Set() };
  for (const option of options) listed.options.add(option);
  listed.quotes.add(quote);
  prices.set(plan, listed);
}

function pricingPassage(raw) {
  const text = raw.slice(0, 150_000);
  const windows = [...text.matchAll(money)].slice(0, 160).map(match => {
    const start = Math.max(0, match.index - 170);
    const end = Math.min(text.length, match.index + 210);
    const passage = text.slice(start, end).trim();
    const score = 2 * Number(/\b(?:billed|billing|annual|monthly)\b/i.test(passage)) +
      2 * Number(/\b(?:per (?:user|seat|month)|\/(?:user|seat|month))\b/i.test(passage)) +
      Number(/\b(?:plan|starter|team|professional|standard|pro|growth)\b/i.test(passage));
    return { start, end, passage, score };
  }).sort((a, b) => b.score - a.score);
  const selected = [];
  for (const window of windows) {
    if (selected.some(existing => existing.start < window.end && window.start < existing.end)) continue;
    selected.push(window);
    if (selected.length === 3) break;
  }
  return selected.map(window => window.passage).join('\n\n---\n\n') || text.slice(0, 850).trim();
}

export function liveProviders({ modelKey, searchKey, model }) {
  return {
    modelName: model,
    async decide(system, input, signal) {
      const canSearch = input.searchAllowance > 0;
      const result = await post('https://api.groq.com/openai/v1/chat/completions', modelKey, {
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
        response_format: { type: 'json_schema', json_schema: { name: canSearch ? 'chat_action' : 'chat_answer',
          strict: true, schema: canSearch ? responseSchema : finalResponseSchema } },
        max_completion_tokens: 1700,
        ...(model.startsWith('openai/gpt-oss-') ? { reasoning_effort: 'low' } : {}),
      }, signal, 'Groq');
      if (Object.hasOwn(result, 'failedGeneration')) {
        const parsed = JSON.parse(result.failedGeneration);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'action')) throw new SyntaxError('Invalid model response');
        return { action: { ...emptyAction, ...parsed }, usage: null };
      }
      const message = result.choices?.[0]?.message;
      return { action: JSON.parse(message?.content ?? 'null'), usage: result.usage ?? null };
    },
    async search(job, signal) {
      const current = job.focus === 'current';
      const pricing = isPricingLookup(job);
      const recent = current && !pricing && !job.allowCached;
      const domains = job.domains ?? [];
      const requestedAt = Date.now();
      const result = await post('https://api.tavily.com/search', searchKey, {
        query: job.query, search_depth: 'basic', max_results: pricing ? 5 : 3,
        include_answer: false, include_raw_content: current && !pricing ? 'markdown' : false,
        include_published_date: true, include_usage: true, auto_parameters: false,
        ...(recent ? { max_age_hours: 24 } : {}),
        ...(domains.length ? { include_domains: domains, include_domains_mode: (pricing || job.focus === 'timeline') && !job.allowCached ? 'restrict' : 'prefer' } : {}),
        ...(job.focus === 'timeline' && job.since ? { start_date: job.since } : {}),
      }, signal, 'Tavily');
      if (!Array.isArray(result.results)) throw new Error('Search response was missing results');
      const sources = [];
      for (const item of result.results) {
        const url = safeWebUrl(item.url);
        if (!url) continue;
        const passage = bestPagePassage(typeof item.raw_content === 'string' ? item.raw_content : '', String(item.content ?? ''), job.query);
        if (!passage.trim() && !pricing) continue;
        sources.push({ url, title: String(item.title || new URL(url).hostname).slice(0, 240), passage,
          requested_at: requestedAt, published_day: typeof item.published_date === 'string' ? item.published_date.slice(0, 10) : null,
          fetch_mode: recent ? 'recent_requested' : 'provider_default', query: job.query });
      }
      if (pricing) sources.sort((a, b) => pricingPageRank(b, job) - pricingPageRank(a, job));
      else if (domains.length) sources.sort((a, b) => Number(matchesDomain(b.url, domains)) - Number(matchesDomain(a.url, domains)));
      return { sources, credits: result.usage?.credits ?? 1 };
    },
    async readPricingPages(pages, signal) {
      const requestedAt = Date.now();
      const wanted = new Map(pages.map(page => [page.url, page]));
      const result = await post('https://api.tavily.com/extract', searchKey, {
        urls: [...wanted.keys()], extract_depth: 'advanced', format: 'markdown', timeout: 10, include_usage: true,
      }, signal, 'Tavily');
      const sources = [];
      for (const item of result.results ?? []) {
        const url = safeWebUrl(item.url);
        if (!url) continue;
        const redirects = pages.filter(page => page.vendor && matchesDomain(url, [page.vendor]) && /\/pricing(?:\/|$)/i.test(new URL(url).pathname));
        const page = wanted.get(url) ?? (redirects.length === 1 ? redirects[0] : null);
        if (!page || typeof item.raw_content !== 'string') continue;
        const passage = pricingPassage(item.raw_content);
        const { title, published_day, query } = page;
        if (passage) sources.push({ url, requestedUrl: page.url, title, published_day, query, passage, requested_at: requestedAt, fetch_mode: 'page_read' });
      }
      return { sources, credits: result.usage?.credits ?? null };
    },
  };
}
