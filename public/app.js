const $ = id => document.getElementById(id);
const form = $('composer');
const question = $('question');
const messages = $('messages');
const scrollArea = $('scroll-area');
const dialog = $('source-dialog');
const sidebar = $('sidebar');
const historyToggle = $('show-history');
const historyBackdrop = $('history-backdrop');
const appearance = $('appearance');
const themeChoices = [...appearance.querySelectorAll('[data-theme-choice]')];
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const state = { chats: [], chat: null, configured: null, busy: false, loading: false, deleting: false, request: null, stage: '', error: '' };
let navigation = 0;

function applyTheme(theme) {
  const choice = ['light', 'dark'].includes(theme) ? theme : 'system';
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  for (const button of themeChoices) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice));
}

try { applyTheme(localStorage.getItem('minimi-theme')); } catch { applyTheme('system'); }

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function openSource(citation) {
  const content = $('source-content');
  content.replaceChildren();
  $('source-title').textContent = citation.title || 'Source';
  if (citation.kind === 'chat') {
    content.append(node('p', citation.day, 'source-meta'), node('blockquote', citation.excerpt));
    const link = node('a', 'Open earlier message');
    link.href = `/?chat=${encodeURIComponent(citation.chatId)}#message-${encodeURIComponent(citation.messageId)}`;
    link.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (state.busy) return;
      dialog.close();
      openChat(citation.chatId, citation.messageId);
    });
    content.append(link);
  } else {
    const checked = citation.requestedAt ? new Date(citation.requestedAt).toLocaleDateString() : '';
    const label = citation.historical ? 'Earlier search' : citation.fetchMode === 'page_read' ? 'Vendor page checked' : citation.fetchMode === 'live_requested' ? 'Fresh page requested'
      : citation.fetchMode === 'recent_requested' ? 'Recent page requested' : 'Search result';
    content.append(node('p', [label, checked, citation.day && `Page date ${citation.day}`].filter(Boolean).join(' · '), 'source-meta'));
    if (citation.excerpt) content.append(node('blockquote', citation.excerpt));
    try {
      const url = new URL(citation.url);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        const link = node('a', `Open source on ${url.hostname}`);
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        content.append(link);
      }
    } catch { /* An unavailable link leaves the saved passage visible. */ }
  }
  if (!dialog.open) dialog.showModal();
}

function citationButton(id, citations) {
  const citation = citations[id];
  if (!citation) return document.createTextNode('');
  const button = node('button', id, 'citation');
  button.type = 'button';
  button.title = citation.title;
  button.setAttribute('aria-label', `Source ${id}: ${citation.title}`);
  button.addEventListener('click', () => openSource(citation));
  return button;
}

function inline(parent, text, citations) {
  const pattern = /\[\[(\d+)\]\]|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    if (match[1]) parent.append(citationButton(match[1], citations));
    else parent.append(node(match[2] ? 'strong' : 'code', match[2] ?? match[3]));
    offset = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}

function formatAnswer(parent, body, citations) {
  let list = null;
  let paragraph = [];
  let code = null;
  const flush = () => {
    if (!paragraph.length) return;
    const p = node('p');
    inline(p, paragraph.join('\n'), citations);
    parent.append(p);
    paragraph = [];
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) {
      if (code) {
        const pre = node('pre');
        pre.append(node('code', code.join('\n')));
        parent.append(pre);
        code = null;
      } else {
        flush();
        list = null;
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const bullet = /^\s*(?:[-*]\s+|(\d+)\.\s+)(.+)$/.exec(line);
    if (bullet) {
      flush();
      const type = bullet[1] ? 'OL' : 'UL';
      if (list?.tagName !== type) {
        list = node(type.toLowerCase());
        if (bullet[1]) list.start = Number(bullet[1]);
        parent.append(list);
      }
      const item = node('li');
      inline(item, bullet[2], citations);
      list.append(item);
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      list = null;
      const element = node('h2');
      inline(element, heading[1], citations);
      parent.append(element);
    } else if (!line.trim()) {
      flush();
      list = null;
    } else {
      list = null;
      paragraph.push(line);
    }
  }
  flush();
  if (code) parent.append(node('pre', code.join('\n')));
}

function comparison(coverage, citations) {
  const wrap = node('div', null, 'comparison');
  wrap.tabIndex = 0;
  wrap.setAttribute('aria-label', 'Product comparison');
  const table = node('table');
  const head = table.createTHead().insertRow();
  const columns = [['Pricing', 'pricing', 'priceRefs'], ['Release', 'release', 'releaseRefs']]
    .filter(([, field]) => coverage.some(row => row[field]));
  for (const label of ['Product', ...columns.map(([label]) => label)]) {
    const cell = node('th', label);
    cell.scope = 'col';
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of coverage) {
    const tr = body.insertRow();
    const title = node('th', row.item);
    title.scope = 'row';
    tr.append(title);
    for (const [, field, refs] of columns) {
      const cell = tr.insertCell();
      cell.textContent = row[field];
      for (const ref of row[refs]) cell.append(' ', citationButton(ref, citations));
    }
  }
  wrap.append(table);
  return wrap;
}

function renderMessage(message) {
  const article = node('article', null, `message ${message.role}`);
  article.id = `message-${message.id}`;
  article.setAttribute('aria-label', message.role === 'user' ? 'Your message' : 'Assistant answer');
  if (message.role === 'user') {
    article.textContent = message.body;
    return article;
  }
  const avatar = node('span', null, 'assistant-avatar');
  avatar.setAttribute('aria-hidden', 'true');
  const mark = node('span', null, 'cat-mark');
  mark.append(node('span'));
  avatar.append(mark);
  const content = node('div', null, 'assistant-content');
  formatAnswer(content, message.body, message.citations);
  if (message.coverage.length) content.append(comparison(message.coverage, message.citations));
  article.append(avatar, content);
  return article;
}

function renderMessages(list) {
  const existing = messages.children;
  if (existing.length > list.length || Array.from(existing).some((article, index) => article.id !== `message-${list[index].id}`)) {
    messages.replaceChildren();
  }
  for (const message of list.slice(existing.length)) messages.append(renderMessage(message));
}

function render() {
  $('configuration').hidden = state.configured !== false;
  $('new-chat').disabled = state.busy || state.deleting;
  const chatRows = state.chats.map(chat => {
    const row = node('div', null, 'history-row');
    const button = node('button', chat.title, 'history-open');
    button.type = 'button';
    button.title = chat.title;
    button.disabled = state.busy || state.deleting;
    if (state.chat?.id === chat.id) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => openChat(chat.id));
    const remove = node('button', '×', 'history-delete');
    remove.type = 'button';
    remove.title = 'Delete chat';
    remove.setAttribute('aria-label', `Delete chat: ${chat.title}`);
    remove.disabled = state.busy || state.loading || state.deleting;
    remove.addEventListener('click', () => deleteChat(chat));
    row.append(button, remove);
    return row;
  });
  $('history').replaceChildren(...(chatRows.length ? chatRows : [node('p', 'No chats yet.', 'history-empty')]));
  const list = state.chat?.messages ?? [];
  const welcome = !list.length && !state.loading && !state.busy;
  const composerArea = $('composer-area');
  const composerTarget = $(welcome ? 'welcome-input' : 'conversation-input');
  if (composerArea.parentElement !== composerTarget) composerTarget.append(composerArea);
  $('welcome').hidden = !welcome;
  $('chat-title').textContent = state.chat?.title || 'New chat';
  messages.hidden = !list.length;
  renderMessages(list);
  $('stop').hidden = !state.busy;
  $('send').hidden = state.busy;
  question.disabled = state.configured !== true || state.busy || state.loading || state.deleting;
  $('send').disabled = question.disabled || !question.value.trim();
  const statusText = state.error || state.stage || (state.loading ? 'Opening chat…' : '');
  $('status').hidden = !statusText;
  if ($('status-copy').textContent !== statusText) $('status-copy').textContent = statusText;
  $('thinking').hidden = !state.busy || !state.stage;
  $('retry').hidden = !(state.error && state.request && !state.busy);
}

function scrollToEnd() {
  scrollArea.scrollTop = scrollArea.scrollHeight;
}

function renderFollowingLatest() {
  const atEnd = scrollArea.scrollHeight - scrollArea.clientHeight - scrollArea.scrollTop <= 40;
  render();
  if (atEnd) scrollToEnd();
  return atEnd;
}

function showSidebar(open) {
  sidebar.classList.toggle('open', open);
  historyToggle.setAttribute('aria-expanded', String(open));
  historyBackdrop.hidden = !open;
}

async function api(path, { data, signal, method = data === undefined ? 'GET' : 'POST' } = {}) {
  const options = data === undefined ? { method, signal } : {
    method, signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  };
  const response = await fetch(path, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Could not connect to the server.');
  }
  return response;
}

function saveChat(chat) {
  const { messages: _messages, ...entry } = chat;
  state.chats = [entry, ...state.chats.filter(previous => previous.id !== chat.id)];
}

async function openChat(id, anchor, push = true) {
  if (state.busy || state.deleting) return;
  const sequence = ++navigation;
  showSidebar(false);
  state.error = '';
  state.request = null;
  state.stage = '';
  state.loading = true;
  render();
  try {
    const chat = await (await api(`/api/chats/${id}`)).json();
    if (sequence !== navigation) return;
    state.chat = chat;
    if (push) history.pushState(null, '', `/?chat=${chat.id}${anchor ? `#message-${anchor}` : ''}`);
    state.loading = false;
    render();
    if (anchor) {
      const message = $(`message-${anchor}`);
      message?.classList.add('highlight');
      message?.scrollIntoView({ block: 'center' });
    } else scrollToEnd();
  } catch (error) {
    if (sequence !== navigation) return;
    state.loading = false;
    state.error = error.message;
    render();
  }
}

function newChat(push = true) {
  if (state.busy || state.deleting) return;
  navigation++;
  state.chat = null;
  state.error = '';
  state.request = null;
  state.stage = '';
  state.loading = false;
  showSidebar(false);
  question.value = '';
  if (push) history.pushState(null, '', '/');
  render();
  if (push) question.focus();
}

async function deleteChat(chat) {
  if (state.busy || state.loading || state.deleting) return;
  if (!window.confirm(`Delete “${chat.title}” and its saved memory?`)) return;
  state.deleting = true;
  state.error = '';
  render();
  let removedOpenChat = false;
  try {
    await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
    state.chats = state.chats.filter(entry => entry.id !== chat.id);
    removedOpenChat = state.chat?.id === chat.id;
    if (state.chat && !removedOpenChat) {
      state.chat = await (await api(`/api/chats/${state.chat.id}`)).json();
      messages.replaceChildren();
    }
  } catch (error) {
    state.error = error.message;
  } finally {
    state.deleting = false;
    if (removedOpenChat) {
      history.replaceState(null, '', '/');
      newChat(false);
    } else render();
  }
}

async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines.filter(Boolean)) onEvent(JSON.parse(line));
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function send(retry) {
  const text = retry?.text ?? question.value.trim();
  if (!text || state.busy || state.loading || state.deleting || !state.configured) return;
  const controller = new AbortController();
  const request = { text, requestId: retry?.requestId ?? crypto.randomUUID(), timezone };
  state.busy = true;
  state.request = request;
  state.controller = controller;
  state.error = '';
  state.stage = 'Starting…';
  question.value = '';
  renderFollowingLatest();
  try {
    if (!state.chat) {
      const chat = await (await api('/api/chats', { data: {}, signal: controller.signal })).json();
      state.chat = { ...chat, messages: [] };
      saveChat(chat);
      history.pushState(null, '', `/?chat=${chat.id}`);
    }
    const response = await api(`/api/chats/${state.chat.id}/messages`, { data: request, signal: controller.signal });
    let finished = false;
    await readEvents(response, event => {
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'progress') {
        state.stage = { history: 'Looking through earlier chats…', search: 'Searching the web…', compare: 'Reading sources…' }[event.stage] || '';
      }
      if (event.message && !state.chat.messages.some(message => message.id === event.message.id)) state.chat.messages.push(event.message);
      if (event.type === 'answer') {
        state.chat.title = event.title;
        state.chat.updated_at = event.message.created_at;
        state.stage = '';
        saveChat(state.chat);
        finished = true;
      }
      renderFollowingLatest();
    });
    if (!finished) throw new Error('The connection closed before the answer arrived.');
    state.request = null;
  } catch (error) {
    state.error = controller.signal.aborted ? 'Stopped.' : error.message;
  } finally {
    state.busy = false;
    state.stage = '';
    state.controller = null;
    if (renderFollowingLatest() && matchMedia('(pointer: fine)').matches) question.focus({ preventScroll: true });
  }
}

function followLocation() {
  const id = new URLSearchParams(location.search).get('chat');
  if (id && /^[0-9a-f-]{36}$/.test(id)) openChat(id, location.hash.match(/^#message-([0-9a-f-]{36})$/)?.[1], false);
  else newChat(false);
}

form.addEventListener('submit', event => { event.preventDefault(); send(); });
question.addEventListener('input', () => { $('send').disabled = !question.value.trim(); });
question.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
$('stop').addEventListener('click', () => state.controller?.abort());
$('retry').addEventListener('click', () => { if (state.request) send(state.request); });
$('new-chat').addEventListener('click', () => newChat());
historyToggle.addEventListener('click', () => {
  appearance.open = false;
  showSidebar(!sidebar.classList.contains('open'));
});
historyBackdrop.addEventListener('click', () => {
  showSidebar(false);
  historyToggle.focus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && sidebar.classList.contains('open')) {
    showSidebar(false);
    historyToggle.focus();
  }
});
for (const button of themeChoices) {
  button.addEventListener('click', () => {
    const theme = button.dataset.themeChoice;
    applyTheme(theme);
    try { localStorage.setItem('minimi-theme', theme); } catch { /* Theme still works for this page. */ }
    appearance.open = false;
    appearance.querySelector('summary').focus();
  });
}
document.addEventListener('click', event => {
  if (appearance.open && !appearance.contains(event.target)) appearance.open = false;
});
appearance.addEventListener('keydown', event => {
  if (event.key === 'Escape' && appearance.open) {
    appearance.open = false;
    appearance.querySelector('summary').focus();
  }
});
window.addEventListener('popstate', followLocation);

try {
  const { configured, chats } = await (await api('/api/chats')).json();
  state.configured = configured;
  state.chats = chats;
  followLocation();
} catch (error) {
  state.error = error.message;
  render();
}
