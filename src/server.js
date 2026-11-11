import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerTurn } from './agent.js';
import { timeZoneOrUtc } from './dates.js';
import { liveProviders } from './providers.js';
import { indexRecentHistory, warmHistorySearch } from './semantic.js';
import { openStore } from './store.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const store = openStore(resolve(project, process.env.DATABASE_PATH || './data/minimi.sqlite'));
const modelKey = process.env.GROQ_API_KEY?.trim();
const searchKey = process.env.TAVILY_API_KEY?.trim();
const configured = Boolean(modelKey && searchKey);
const model = process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b';
const providers = liveProviders({ modelKey, searchKey, model });
const port = Number(process.env.PORT || 3000);
const activeChats = new Set();
const activeOwners = new Set();
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['generated.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/fonts/dm-sans.woff2', ['fonts/dm-sans.woff2', 'font/woff2']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON.');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32_000) throw new HttpError(413, 'The message is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* Send a consistent error below. */ }
  throw new HttpError(400, 'The request is not valid JSON.');
}

function session(request, response) {
  const existing = request.headers.cookie?.match(/(?:^|;\s*)minimi_session=([0-9a-f]{64})(?:;|$)/)?.[1];
  if (existing && store.hasSession(existing)) return existing;
  const id = randomBytes(32).toString('hex');
  store.createSession(id);
  response.setHeader('Set-Cookie', `minimi_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
  return id;
}

function outputMessage(message) {
  const { id, role, body, created_at, timezone, reply_to, citations, coverage } = message;
  return { id, role, body, created_at, timezone, reply_to, citations, coverage };
}

async function messageRoute(request, response, owner, chat) {
  const input = await body(request);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text || text.length > 6000) throw new HttpError(400, 'Enter a message of 1 to 6,000 characters.');
  if (typeof input.requestId !== 'string' || !/^[a-z0-9-]{12,80}$/i.test(input.requestId)) throw new HttpError(400, 'A valid request ID is required.');
  if (!configured) throw new HttpError(503, 'Add Groq and Tavily keys to .env and restart.');
  if (activeChats.has(chat.id) || activeOwners.has(owner)) throw new HttpError(409, 'Finish or stop your current answer first.');
  activeChats.add(chat.id);
  activeOwners.add(owner);
  const controller = new AbortController();
  response.on('close', () => {
    if (!response.writableEnded) controller.abort();
  });
  const zone = timeZoneOrUtc(input.timezone);
  const emit = (type, data) => {
    if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify({ type, ...data })}\n`);
  };
  try {
    const { message } = store.addUserMessage(chat, text, input.requestId, Date.now(), zone);
    if (message.body !== text) throw new HttpError(409, 'That request ID already belongs to another message.');
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    emit('saved', { message: outputMessage(message) });
    const answer = await answerTurn({ store, chat, user: message, providers,
      signal: controller.signal, onProgress: (stage, count) => emit('progress', { stage, count }) });
    emit('answer', { message: outputMessage(answer), title: store.chat(owner, chat.id).title });
    indexRecentHistory(store, chat);
  } catch (error) {
    if (!response.headersSent) throw error;
    if (!controller.signal.aborted) {
      const known = /^Groq /.test(error.message);
      const message = error.name === 'TimeoutError' ? 'The request took too long. You can retry.' : known ? `${error.message}. You can retry.` : 'The answer could not be completed. You can retry.';
      if (!known) console.error('Chat request failed', error.name);
      emit('error', { message });
    }
  } finally {
    activeChats.delete(chat.id);
    activeOwners.delete(owner);
    if (response.headersSent && !response.writableEnded && !response.destroyed) response.end();
  }
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try {
    if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(request.headers.host ?? '')) throw new HttpError(403, 'Open this app on localhost.');
    const { pathname } = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && assets.has(pathname)) {
      const [file, contentType] = assets.get(pathname);
      const content = await readFile(new URL(`../public/${file}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      return response.end(content);
    }
    if (!pathname.startsWith('/api/')) throw new HttpError(404, 'Page not found.');
    const origin = request.headers.origin;
    if (['POST', 'DELETE'].includes(request.method) && origin && origin !== `http://${request.headers.host}`) {
      throw new HttpError(403, 'Open this app directly in your browser.');
    }
    const owner = session(request, response);
    if (pathname === '/api/chats' && request.method === 'GET') return json(response, 200, { configured, chats: store.chats(owner) });
    if (pathname === '/api/chats' && request.method === 'POST') {
      await body(request);
      const { id, title, updated_at } = store.newChat(owner);
      return json(response, 201, { id, title, updated_at });
    }
    const match = /^\/api\/chats\/([0-9a-f-]{36})(\/messages)?$/.exec(pathname);
    if (!match) throw new HttpError(404, 'Page not found.');
    const chat = store.chat(owner, match[1]);
    if (!chat) throw new HttpError(404, 'Chat not found.');
    if (!match[2] && request.method === 'GET') {
      const { id, title, updated_at } = chat;
      return json(response, 200, { id, title, updated_at, messages: store.messages(owner, id).map(outputMessage) });
    }
    if (!match[2] && request.method === 'DELETE') {
      if (activeOwners.has(owner)) throw new HttpError(409, 'Finish or stop your current answer first.');
      store.deleteChat(owner, chat.id);
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      return response.end();
    }
    if (match[2] && request.method === 'POST') return await messageRoute(request, response, owner, chat);
    throw new HttpError(405, 'Method not supported.');
  } catch (error) {
    if (response.destroyed || response.writableEnded) return;
    if (!(error instanceof HttpError)) console.error('Request failed', error.name);
    json(response, error.status ?? 500, { error: error instanceof HttpError ? error.message : 'Something went wrong.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Minimi Chat is ready at http://localhost:${server.address().port}`);
  if (configured) warmHistorySearch();
  else console.log('Live chat needs GROQ_API_KEY and TAVILY_API_KEY in .env.');
});
