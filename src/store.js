import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const stopWords = new Set('a an and answer are as ask asked at be been before by can chat check consider decide did discuss do does earlier for from had has have how i in is it last latest me my of on or our question recall remember remind said since so still than that the them then there these they this those time to today tools was we were what when where which who will with would you your'.split(' '));
const beforeMessage = 'COALESCE((SELECT rowid FROM messages WHERE id = ?), 9223372036854775807)';

export function searchWords(text) {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter(word => word.length > 1 && !stopWords.has(word) && !/^\d{4}$/.test(word));
}

function searchTerms(text) {
  const words = searchWords(text);
  if (words.includes('postgres')) words.push('postgresql');
  if (words.includes('postgresql')) words.push('postgres');
  return [...new Set(words)].slice(0, 14).map(word => `"${word}"`).join(' OR ');
}

function parseMessage(row) {
  return { ...row, citations: JSON.parse(row.citations), coverage: JSON.parse(row.coverage) };
}

function parseRecord(row) {
  return { ...row, data: JSON.parse(row.data) };
}

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES sessions(id),
      title TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chats_owner ON chats(owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
      role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
      timezone TEXT NOT NULL, reply_to TEXT REFERENCES messages(id),
      request_id TEXT, citations TEXT NOT NULL DEFAULT '{}', coverage TEXT NOT NULL DEFAULT '[]',
      UNIQUE(chat_id, request_id), UNIQUE(reply_to)
    );
    CREATE INDEX IF NOT EXISTS messages_chat_order ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(body, tokenize='unicode61');
    CREATE TRIGGER IF NOT EXISTS index_message AFTER INSERT ON messages BEGIN
      INSERT INTO message_search(rowid, body) VALUES(new.rowid, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS unindex_message AFTER DELETE ON messages BEGIN
      DELETE FROM message_search WHERE rowid = old.rowid;
    END;
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id),
      request_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
      passage TEXT NOT NULL, requested_at INTEGER NOT NULL, published_day TEXT,
      fetch_mode TEXT NOT NULL, query TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
      kind TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_message ON memories(message_id);
    CREATE TABLE IF NOT EXISTS history_vectors (
      message_id TEXT PRIMARY KEY REFERENCES messages(id), model TEXT NOT NULL, vector BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, user_message_id TEXT NOT NULL REFERENCES messages(id),
      started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}'
    );
  `);

  const transaction = operation => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const store = {
    close: () => db.close(),

    hasSession(id) {
      return Boolean(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id));
    },

    createSession(id, now = Date.now()) {
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run(id, now);
    },

    newChat(ownerId, now = Date.now()) {
      const chat = { id: randomUUID(), owner_id: ownerId, title: 'New chat', updated_at: now };
      db.prepare('INSERT INTO chats VALUES (?, ?, ?, ?)').run(chat.id, ownerId, chat.title, now);
      return chat;
    },

    chats(ownerId) {
      return db.prepare('SELECT id, title, updated_at FROM chats WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100').all(ownerId);
    },

    chat(ownerId, chatId) {
      return db.prepare('SELECT * FROM chats WHERE owner_id = ? AND id = ?').get(ownerId, chatId);
    },

    deleteChat(ownerId, chatId) {
      return transaction(() => {
        if (!store.chat(ownerId, chatId)) return false;
        const sourceIds = new Set(db.prepare('SELECT id FROM sources WHERE chat_id = ?').all(chatId).map(row => row.id));
        const linked = db.prepare(`SELECT m.id, m.citations, m.coverage FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE c.owner_id = ? AND m.chat_id != ? AND EXISTS (
            SELECT 1 FROM json_each(m.citations) AS citation
            WHERE json_extract(citation.value, '$.chatId') = ? OR json_extract(citation.value, '$.sourceId')
              IN (SELECT id FROM sources WHERE chat_id = ?)
          )`).all(ownerId, chatId, chatId, chatId);
        const updateLinks = db.prepare('UPDATE messages SET citations = ?, coverage = ? WHERE id = ?');
        for (const row of linked) {
          const citations = Object.fromEntries(Object.entries(JSON.parse(row.citations)).filter(([, citation]) =>
            citation.chatId !== chatId && !sourceIds.has(citation.sourceId)));
          const coverage = JSON.parse(row.coverage).map(item => ({
            ...item,
            priceRefs: (item.priceRefs ?? []).filter(ref => Object.hasOwn(citations, ref)),
            releaseRefs: (item.releaseRefs ?? []).filter(ref => Object.hasOwn(citations, ref)),
          }));
          updateLinks.run(JSON.stringify(citations), JSON.stringify(coverage), row.id);
        }
        db.prepare(`UPDATE memories SET data = json_set(data, '$.replaces', NULL)
          WHERE kind = 'shortlist' AND json_extract(data, '$.replaces') IN (
            SELECT r.id FROM memories r JOIN messages m ON m.id = r.message_id WHERE m.chat_id = ?
          )`).run(chatId);
        db.prepare('DELETE FROM history_vectors WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM memories WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM runs WHERE user_message_id IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
        db.prepare('DELETE FROM sources WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
        db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
        return true;
      });
    },

    messages(ownerId, chatId) {
      return db.prepare(`SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE c.owner_id = ? AND c.id = ? ORDER BY m.rowid`).all(ownerId, chatId).map(parseMessage);
    },

    addUserMessage(chat, body, requestId, createdAt, timeZone) {
      return transaction(() => {
        const found = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND request_id = ?').get(chat.id, requestId);
        if (found) return { message: parseMessage(found), reused: true };
        const id = randomUUID();
        db.prepare(`INSERT INTO messages (id, chat_id, role, body, created_at, timezone, request_id)
          VALUES (?, ?, 'user', ?, ?, ?, ?)`).run(id, chat.id, body, createdAt, timeZone, requestId);
        const title = body.replace(/\s+/g, ' ').slice(0, 62);
        db.prepare(`UPDATE chats SET updated_at = ?, title = CASE WHEN title = 'New chat' THEN ? ELSE title END WHERE id = ?`)
          .run(createdAt, title, chat.id);
        return { message: parseMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id)), reused: false };
      });
    },

    reply(userMessageId) {
      const row = db.prepare('SELECT * FROM messages WHERE reply_to = ?').get(userMessageId);
      return row ? parseMessage(row) : null;
    },

    addSource(chatId, runId, source) {
      const id = randomUUID();
      db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, chatId, runId, source.url, source.title, source.passage,
          source.requested_at, source.published_day, source.fetch_mode, source.query);
      return { id, chat_id: chatId, ...source };
    },

    saveAnswer(user, { body, citations, coverage = [], memories = [] }, createdAt) {
      return transaction(() => {
        const existing = store.reply(user.id);
        if (existing) return existing;
        const id = randomUUID();
        db.prepare(`INSERT INTO messages (id, chat_id, role, body, created_at, timezone, reply_to, citations, coverage)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`).run(id, user.chat_id, body, createdAt, user.timezone,
          user.id, JSON.stringify(citations), JSON.stringify(coverage));
        const insert = db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?)');
        for (const memory of memories) insert.run(randomUUID(), id, memory.kind, JSON.stringify(memory.data));
        db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(createdAt, user.chat_id);
        return parseMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
      });
    },

    recent(chat, excludedId, limit = 10) {
      return db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND rowid < ${beforeMessage} ORDER BY rowid DESC LIMIT ?`)
        .all(chat.id, excludedId, limit).reverse().map(parseMessage);
    },

    messageAt(chat, excludedId, role, position) {
      const row = db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND role = ? AND rowid < ${beforeMessage}
        ORDER BY rowid ${position < 0 ? 'DESC' : 'ASC'} LIMIT 1 OFFSET ?`)
        .get(chat.id, role, excludedId, Math.abs(position) - 1);
      return row ? parseMessage(row) : null;
    },

    historicalMessage(chat, excludedId, messageId, currentChatOnly = false) {
      const row = db.prepare(`SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE c.owner_id = ? AND m.id = ? AND m.rowid < ${beforeMessage} AND (? IS NULL OR m.chat_id = ?)`)
        .get(chat.owner_id, messageId, excludedId, currentChatOnly ? chat.id : null, chat.id);
      return row ? parseMessage(row) : null;
    },

    inDateRange(chat, excludedId, range, currentChatOnly = false, limit = 41) {
      return db.prepare(`SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE c.owner_id = ?
          AND m.role = 'user' AND m.rowid < ${beforeMessage} AND m.created_at >= ? AND m.created_at < ?
          AND (? IS NULL OR m.chat_id = ?)
        ORDER BY m.created_at, m.rowid LIMIT ?`)
        .all(chat.owner_id, excludedId, range.from, range.until, currentChatOnly ? chat.id : null, chat.id, limit).map(parseMessage);
    },

    matching(chat, excludedId, text, { limit = 10, range, currentChatOnly = false } = {}) {
      const terms = searchTerms(text);
      if (!terms) return [];
      return db.prepare(`SELECT m.* FROM message_search
        JOIN messages m ON m.rowid = message_search.rowid JOIN chats c ON c.id = m.chat_id
        LEFT JOIN messages q ON q.id = m.reply_to
        WHERE message_search MATCH ? AND c.owner_id = ? AND m.rowid < ${beforeMessage}
          AND (? IS NULL OR m.chat_id = ?)
          AND (? IS NULL OR COALESCE(q.created_at, m.created_at) >= ? AND COALESCE(q.created_at, m.created_at) < ?)
        ORDER BY bm25(message_search), m.chat_id = ? DESC, m.rowid DESC LIMIT ?`)
        .all(terms, chat.owner_id, excludedId, currentChatOnly ? chat.id : null, chat.id,
          range?.from ?? null, range?.from ?? null, range?.until ?? null, chat.id, limit).map(parseMessage);
    },

    exchange(message, excludedId) {
      if (message.role === 'user') {
        const reply = db.prepare(`SELECT * FROM messages WHERE reply_to = ? AND rowid < ${beforeMessage}`).get(message.id, excludedId);
        return reply ? [message, parseMessage(reply)] : [message];
      }
      const parent = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.reply_to);
      return parent ? [parseMessage(parent), message] : [message];
    },

    recentShortlists(chat, excludedId) {
      return db.prepare(`SELECT m.* FROM messages m JOIN memories r ON r.message_id = m.id
        WHERE m.chat_id = ? AND r.kind = 'shortlist' AND m.rowid < ${beforeMessage}
        ORDER BY m.rowid DESC LIMIT 2`).all(chat.id, excludedId).map(parseMessage);
    },

    unindexedHistory(chat, beforeId, model, currentChatOnly, limit) {
      const query = direction => db.prepare(`SELECT q.id, q.body, a.body AS answer FROM messages q
        JOIN chats c ON c.id = q.chat_id JOIN messages a ON a.reply_to = q.id
        LEFT JOIN history_vectors v ON v.message_id = q.id AND v.model = ?
        WHERE c.owner_id = ? AND a.rowid < ${beforeMessage} AND v.message_id IS NULL AND (? IS NULL OR q.chat_id = ?)
        ORDER BY q.rowid ${direction} LIMIT ?`);
      const params = [model, chat.owner_id, beforeId, currentChatOnly ? chat.id : null, chat.id];
      const oldest = query('ASC').all(...params, Math.min(24, Math.floor(limit / 4)));
      const newest = query('DESC').all(...params, limit);
      return [...new Map([...oldest, ...newest].map(row => [row.id, row])).values()].slice(0, limit);
    },

    saveHistoryVectors(model, rows) {
      const save = db.prepare(`INSERT INTO history_vectors SELECT id, ?, ? FROM messages WHERE id = ? ON CONFLICT(message_id)
        DO UPDATE SET model = excluded.model, vector = excluded.vector`);
      transaction(() => {
        for (const { id, vector } of rows) save.run(model, vector, id);
      });
    },

    historyVectors(chat, beforeId, model, currentChatOnly) {
      return db.prepare(`SELECT q.id, v.vector FROM history_vectors v JOIN messages q ON q.id = v.message_id
        JOIN messages a ON a.reply_to = q.id JOIN chats c ON c.id = q.chat_id
        WHERE v.model = ? AND c.owner_id = ? AND a.rowid < ${beforeMessage} AND (? IS NULL OR q.chat_id = ?)`)
        .iterate(model, chat.owner_id, beforeId, currentChatOnly ? chat.id : null, chat.id);
    },

    memories(messages) {
      const query = db.prepare('SELECT * FROM memories WHERE message_id = ? ORDER BY rowid');
      return messages.flatMap(message => message.role === 'assistant' ? query.all(message.id).map(parseRecord) : []);
    },

    source(chat, id) {
      return db.prepare(`SELECT s.* FROM sources s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ? AND c.owner_id = ?`)
        .get(id, chat.owner_id);
    },

    startRun(userId, startedAt) {
      const id = randomUUID();
      db.prepare(`INSERT INTO runs (id, user_message_id, started_at, status) VALUES (?, ?, ?, 'running')`)
        .run(id, userId, startedAt);
      return id;
    },

    endRun(id, endedAt, status, details) {
      db.prepare('UPDATE runs SET ended_at = ?, status = ?, details = ? WHERE id = ?')
        .run(endedAt, status, JSON.stringify(details), id);
    },
  };
  return store;
}
