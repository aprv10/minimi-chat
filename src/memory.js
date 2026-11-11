import { addDays, dateRanges, formatCalendarDay, localDay } from './dates.js';
import { searchWords } from './store.js';

const earlierDiscussion = /\b(?:did (?:i|we|you) (?:ask|say|discuss|shortlist|recommend|pick|decide|compare|consider|evaluate|choose|look at)|(?:i|we|you) (?:asked|said|discussed|shortlisted|recommended|picked|decided|compared|considered|evaluated|chose|looked at)|(?:my|our|your) (?:previous|earlier|last) (?:answer|chat|question|discussion|recommendation|shortlist))\b/i;
const followUp = /\b(?:since then|still|those|again|the shortlist|which one|the second one|last time|our shortlist|the same options|that (?:answer|option|recommendation|decision))\b/i;
const weekdayQuestion = /^(?:what|which)\s+(?:(?:was|is)\s+the\s+)?(?:day(?: of (?:the )?week)?|weekday)\b\s*/i;
const dateReference = /\b(?:that (?:date|day)|on the same day|the date we (?:discussed|talked about))\b/i;
const currentChat = /\b(?:in|from|of) (?:this|the current) (?:chat|conversation)\b/i;
const positions = new Map('first second third fourth fifth sixth seventh eighth ninth tenth'.split(' ').map((word, index) => [word, index + 1]));
for (const [word, position] of [['opening', 1], ['last', -1], ['previous', -1], ['latest', -1]]) positions.set(word, position);
const ordinal = new RegExp(`\\b(?:(my|your|the|our)\\s+)?(?:very\\s+)?(${[...positions.keys()].join('|')}|[1-9]\\d{0,5}(?:st|nd|rd|th))\\s+(question|answer|reply|response|message)\\b|\\b(question|answer|reply|response)\\s+(?:#|number\\s+)?([1-9]\\d{0,5})\\b`, 'i');
const maxHistory = 7600;
const entryCost = 160;

function positionReference(question) {
  if (/\b(?:in|from|of) (?:another|that|an earlier|a previous|(?:our|my|the) (?:last|earlier|previous|other)) chat\b/i.test(question)) return null;
  if (/^what did i ask (?:you )?first(?: in this (?:chat|conversation))?[?.!]*$/i.test(question)) {
    return { role: 'user', position: 1, exact: true };
  }
  const match = ordinal.exec(question);
  if (!match) return null;
  const [, owner, word, kind, numberedKind, number] = match;
  const type = (kind ?? numberedKind).toLowerCase();
  if (type === 'question' && (owner?.toLowerCase() === 'your' || /^ you asked\b/i.test(question.slice(match.index + match[0].length)))) return null;
  const role = type === 'question' || (type === 'message' && owner?.toLowerCase() !== 'your') ? 'user' : 'assistant';
  const position = number ? Number(number) : positions.get(word.toLowerCase()) ?? parseInt(word, 10);
  const before = question.slice(0, match.index).trim();
  const after = question.slice(match.index + match[0].length).replace(/[?.!]+$/, '').trim();
  const exact = /^(?:what (?:was|is)|(?:please )?(?:show me|tell me|repeat|quote))?$/i.test(before) &&
    /^(?:(?:i (?:asked(?: you)?|sent)|you (?:gave|sent|wrote))(?:\s+|$))?(?:(?:in|of) (?:this|the current) (?:chat|conversation))?$/i.test(after);
  if (number && !exact && !match[0].includes('#') && !currentChat.test(question)) return null;
  if (!exact && !/^(?:my|your|our)$/i.test(owner ?? '') && !number && !currentChat.test(question) && !/^i asked\b/i.test(after)) return null;
  return { role, position, exact };
}

function excerpt(text, limit, terms) {
  if (text.length <= limit) return text;
  const separator = '\n[…]\n';
  const head = Math.floor(limit * 0.31);
  const tail = Math.floor(limit * 0.30);
  const middleSize = limit - head - tail - separator.length * 2;
  const middleEnd = text.length - tail - middleSize;
  let best = { score: 0, start: 0 };
  for (let start = head; start <= middleEnd; start += Math.max(80, Math.floor(middleSize / 2))) {
    const words = new Set(searchWords(text.slice(start, start + middleSize)));
    const score = terms.filter(term => words.has(term)).length;
    if (score > best.score) best = { score, start };
  }
  if (!best.score) return text.slice(0, limit - tail - separator.length) + separator + text.slice(-tail);
  return text.slice(0, head) + separator + text.slice(best.start, best.start + middleSize) + separator + text.slice(-tail);
}

function dayMentions(text, time, zone) {
  return dateRanges(text, time, zone).filter(range => range.end === addDays(range.start, 1));
}

function weekdayTarget(text) {
  return text.replace(weekdayQuestion, '').trim().replace(/^(?:was|is|did|will)\s+/i, '')
    .replace(/^(?:(?:it\s+)?on\s+|it\s+(?=today|yesterday|tomorrow))/i, '').replace(/[?.!]+$/, '')
    .replace(/\s+(?:fall on|be)\s*$/i, '').trim().toLowerCase();
}

function priorDateMention(recent) {
  for (const message of recent) {
    if (message.role !== 'user') continue;
    const mentioned = dayMentions(message.body, message.created_at, message.timezone);
    if (!mentioned.length) continue;
    const historyDates = mentioned.filter(range => range.phrase.toLowerCase() !== 'today');
    return { message, dates: earlierDiscussion.test(message.body) && historyDates.length ? historyDates : mentioned };
  }
  return null;
}

export function weekdayAnswer(store, chat, user, now) {
  const question = user.body.trim();
  const asksWeekday = weekdayQuestion.test(question);
  if (!asksWeekday && !/^on\s+/i.test(question)) return null;
  const recent = store.recent(chat, user.id, 10).reverse().filter(message => message.role === 'user');
  // A date alone can correct the immediately preceding weekday question.
  if (!asksWeekday && !weekdayQuestion.test(recent[0]?.body.trim() ?? '')) return null;
  const target = weekdayTarget(question);
  let dates = dayMentions(target, now, user.timezone).filter(range => range.phrase.toLowerCase().replace(/^on /, '') === target);
  let original = null;
  if (asksWeekday && target === 'it' && /^what day is it[?.!]*$/i.test(question)) dates = dayMentions('today', now, user.timezone);
  if (asksWeekday && /^(?:that(?: date| day)?|then|it|the date)$/.test(target) && !dates.length) {
    const reference = priorDateMention(recent);
    if (!reference) return { body: 'Which date do you mean?', citations: {} };
    dates = reference.dates;
    original = reference.message;
  }
  if (!dates.length) return null;
  if (dates.length > 1) return { body: `Do you mean ${dates.map(range => formatCalendarDay(range.start)).join(' or ')}?`, citations: {} };
  const day = formatCalendarDay(dates[0].start);
  return { body: original ? `${day}. [[1]]` : `${day}.`, citations: original ? { 1: chatCitation(original) } : {} };
}

function distinctExchanges(messages) {
  const exchanges = new Map();
  for (const message of messages) {
    const id = message.reply_to ?? message.id;
    if (!exchanges.has(id)) exchanges.set(id, message);
  }
  return [...exchanges.values()];
}

export function getMemory(store, chat, user, now, { historyQueries = [], related = [] } = {}) {
  const today = localDay(now, user.timezone);
  const mentioned = dateRanges(user.body, now, user.timezone);
  const recent = store.recent(chat, user.id, 10).reverse();
  const currentChatOnly = currentChat.test(user.body);
  const position = positionReference(user.body.trim());
  const target = position && store.messageAt(chat, user.id, position.role, position.position);
  const exchange = message => store.exchange(message, user.id);
  const targetExchange = target ? exchange(target) : [];
  const reference = dateReference.test(user.body) && mentioned.every(range => range.phrase.toLowerCase() === 'today')
    ? priorDateMention(recent) : null;
  const dates = reference?.dates ?? mentioned;
  const asksAboutHistory = earlierDiscussion.test(user.body) || /^show me my questions\b/i.test(user.body);
  const isFollowUp = followUp.test(user.body);
  const past = dates.filter(range => range.phrase.toLowerCase() !== 'today');
  const relevantDates = asksAboutHistory && dates.length ? (past.length ? past : dates) : [];
  const matches = relevantDates.map(range => ({ ...range, messages: store.inDateRange(chat, user.id, range, currentChatOnly) }));
  const recallQuestion = /^(?:what did i ask(?: you)?|show me my questions)(?: on)?\s+/i;
  const exactRecall = recallQuestion.test(user.body) &&
    relevantDates.length > 0 && relevantDates.some(range =>
      user.body.replace(recallQuestion, '').replace(currentChat, '').replace(/[?.!]+$/, '').trim().toLowerCase() === range.phrase.toLowerCase().replace(/^on /, ''));
  const missingRecheck = /\b(?:still|since then|changed|recheck)\b/i.test(user.body) && matches.length > 0 &&
    matches.every(group => !group.messages.length);

  const messages = new Map();
  const terms = [...new Set([user.body, ...historyQueries].flatMap(searchWords))].slice(0, 32);
  let remaining = maxHistory;
  const proof = new Set();
  const append = (message, limit) => {
    if (messages.has(message.id) || remaining < entryCost + 240) return;
    const text = excerpt(message.body, Math.min(limit, remaining - entryCost), terms);
    const key = `H${messages.size + 1}`;
    messages.set(message.id, { key, message, text });
    remaining -= text.length + entryCost;
  };
  const appendExchange = (hit, userLimit = 670, replyLimit = 1050) => {
    for (const message of exchange(hit)) {
      proof.add(message.id);
      append(message, message.role === 'user' ? userLimit : replyLimit);
    }
  };
  const hits = range => distinctExchanges([...historyQueries, user.body].flatMap(query =>
    store.matching(chat, user.id, query, { range, currentChatOnly, limit: 12 })));

  // Keep recent context available even when the question also refers to old history.
  for (const [index, message] of recent.slice(0, 4).entries()) {
    if (index < 2) append(message, message.role === 'user' ? 1000 : 2100);
    else append(message, message.role === 'user' ? 580 : 1050);
  }
  if (!terms.length || /\b(?:just|latest|previous|most recent)\b/i.test(user.body)) {
    for (const message of recent.slice(0, 2)) proof.add(message.id);
  }
  for (const message of targetExchange) append(message, message.role === 'user' ? 1100 : 1700);
  if (reference) append(reference.message, 720);
  if (!position && !matches.length && isFollowUp) {
    const links = recent.filter(message => message.role === 'assistant').slice(0, 2)
      .flatMap(message => Object.values(message.citations).filter(citation => citation.kind === 'chat').map(citation => citation.messageId));
    for (const messageId of [...new Set(links)].slice(0, 2)) {
      const source = store.historicalMessage(chat, user.id, messageId, currentChatOnly);
      if (source) appendExchange(source);
    }
  }
  let hasKeywordMatch = false;
  if (matches.length) {
    const candidates = matches.map(group => distinctExchanges([...hits(group), ...group.messages]).slice(0, 6)).filter(group => group.length);
    if (candidates.length > 1) {
      const share = Math.max(240, Math.floor(remaining / (2 * candidates.length)) - entryCost);
      for (const group of candidates) appendExchange(group[0], Math.min(670, share), Math.min(1050, share));
    }
    for (let index = candidates.length > 1 ? 1 : 0; index < 6 && remaining >= entryCost + 240; index++) {
      for (const group of candidates) if (group[index]) appendExchange(group[index]);
    }
  } else if (!position) {
    const lexical = hits().slice(0, asksAboutHistory || isFollowUp ? 6 : 3);
    hasKeywordMatch = lexical.some(hit => {
      const words = new Set(exchange(hit).flatMap(message => searchWords(message.body)));
      return terms.filter(term => words.has(term)).length >= Math.min(2, terms.length);
    });
    if (isFollowUp && /\b(?:the|our|that|this|same) shortlist\b/i.test(user.body)) {
      for (const hit of store.recentShortlists(chat, user.id)) appendExchange(hit);
    }
    const similar = related.map(id => store.historicalMessage(chat, user.id, id, currentChatOnly)).filter(Boolean);
    for (const hit of distinctExchanges([...similar, ...lexical]).slice(0, 6)) appendExchange(hit);
  }
  for (const message of recent.slice(4)) append(message, 720);

  const byKey = new Map([...messages.values()].map(entry => [entry.key, entry]));
  const records = new Map();
  const available = store.memories([...messages.values()].map(entry => entry.message));
  const shortlists = available.filter(record => record.kind === 'shortlist').slice(0, 5);
  const otherRecords = available.filter(record => record.kind !== 'shortlist');
  for (const record of [...shortlists, ...otherRecords].slice(0, 22)) {
    const entry = messages.get(record.message_id);
    records.set(`M${records.size + 1}`, { ...record, history: entry.key });
  }
  const byTime = [...messages.values()].sort((a, b) => a.message.created_at - b.message.created_at ||
    Number(a.message.role === 'assistant') - Number(b.message.role === 'assistant'));
  const positionRefs = targetExchange.map(message => messages.get(message.id)?.key).filter(Boolean);
  const dateMatches = matches.map(group => {
    const ids = new Set(byTime.filter(({ message }) => message.role === 'user' && message.created_at >= group.from && message.created_at < group.until)
      .map(({ message }) => message.id));
    return { date: group.start, endExclusive: group.end, phrase: group.phrase, found: group.messages.length,
      truncated: group.messages.length === 41 || group.messages.some(message => !ids.has(message.id)),
      refs: byTime.filter(({ message }) => ids.has(message.reply_to ?? message.id)).map(({ key }) => key) };
  });
  const historyProof = position ? positionRefs : matches.length ? dateMatches.flatMap(match => match.refs)
    : byTime.filter(({ message }) => proof.has(message.id)).map(({ key }) => key);
  const useSemantic = asksAboutHistory && !position && !matches.length && terms.length > 1 && !hasKeywordMatch;
  return { today, dates, matches, exactRecall, missingRecheck, byKey, records, position, target, targetExchange, historyProof,
    currentChatOnly, useSemantic, requiresHistory: Boolean(asksAboutHistory || position),
    context: {
      historySearchAllowed: !historyQueries.length && !position && (asksAboutHistory || isFollowUp) && (!matches.length || matches.some(group => group.messages.length)),
      history: byTime.map(({ key, message, text }) => ({ id: key, role: message.role, text, day: localDay(message.created_at, user.timezone),
        time: new Date(message.created_at).toISOString(), currentChat: message.chat_id === chat.id })),
      ...(reference ? { referencedDate: { dates: reference.dates.map(range => range.start), from: messages.get(reference.message.id)?.key } } : {}),
      ...(position ? { referencedPosition: { found: Boolean(target), role: position.role, position: position.position,
        refs: positionRefs } } : {}),
      dateMatches,
      records: [...records].map(([id, record]) => {
        const { sourceId, quote, replaces, ...data } = record.data;
        const previous = replaces ? [...records].find(([, candidate]) => candidate.id === replaces)?.[0] : null;
        return { id, from: record.history, kind: record.kind, ...data, ...(previous ? { replaces: previous } : {}) };
      }),
    },
  };
}

export function chatCitation(message) {
  return { kind: 'chat', chatId: message.chat_id, messageId: message.id, title: 'Earlier chat',
    day: localDay(message.created_at, message.timezone), excerpt: message.body.slice(0, 420) };
}

export function recallAnswer(memory, timeZone) {
  if (memory.position && !memory.target) {
    const type = memory.position.role === 'user' ? 'question' : 'answer';
    return { body: `I couldn't find that ${type} in this chat.`, citations: {} };
  }
  if (memory.position?.exact) {
    const target = memory.target;
    const text = target.body.replace(/\s*\[\[\d+\]\]/g, '').trim();
    return { body: `${text}\n\n[[1]]`, citations: { 1: chatCitation(target) } };
  }
  if (memory.missingRecheck) {
    const scope = memory.currentChatOnly ? 'this chat' : 'this browser’s history';
    return { body: `I found no saved questions for ${memory.matches.map(range => range.start).join(' or ')} in ${scope}, so I don’t have an earlier answer to recheck.`, citations: {} };
  }
  if (!memory.exactRecall) return null;
  const nonempty = memory.matches.filter(range => range.messages.length);
  if (nonempty.length > 1) {
    return { body: `I found conversations on ${nonempty.map(range => range.start).join(' and ')}. Which date did you mean?`, citations: {} };
  }
  if (!nonempty.length) {
    const scope = memory.currentChatOnly ? 'this chat' : 'this browser’s history';
    return { body: `I found no saved questions for ${memory.matches.map(range => range.start).join(' or ')} in ${scope}.`, citations: {} };
  }
  const range = nonempty[0];
  const citations = {};
  const lines = range.messages.slice(0, 40).map((message, index) => {
    const id = String(index + 1);
    citations[id] = chatCitation(message);
    return `- ${message.body.replace(/\[\[\d+\]\]/g, '').replace(/\s+/g, ' ')} [[${id}]]`;
  });
  return { body: [`Here’s what you asked ${range.end === memory.today ? 'yesterday, ' : 'on '}${range.start} (${timeZone}).`, '',
    ...lines, ...(range.messages.length > 40 ? ['', 'There are more messages in that period. You can open the earlier chats from the links above.'] : [])].join('\n'), citations };
}
