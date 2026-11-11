import { fileURLToPath } from 'node:url';

const model = 'Xenova/bge-small-en-v1.5';
const modelVersion = `${model}:q8:2`;
let loading;
let retryAfter = 0;

function encoder() {
  if (!loading && Date.now() >= retryAfter) {
    loading = import('@huggingface/transformers').then(({ env, pipeline }) => {
      env.cacheDir = fileURLToPath(new URL('../data/models/', import.meta.url));
      return pipeline('feature-extraction', model, { dtype: 'q8', device: 'cpu' });
    }).catch(() => {
      loading = undefined;
      retryAfter = Date.now() + 60_000;
      return null;
    });
  }
  return loading ?? Promise.resolve(null);
}

export function warmHistorySearch() {
  void encoder();
}

function encode(pipe, texts) {
  return pipe(texts, { pooling: 'cls', normalize: true });
}

function memoryText({ body, answer }) {
  const question = body.length <= 850 ? body : `${body.slice(0, 575)}\n${body.slice(-275)}`;
  const reply = answer.replace(/\[\[\d+\]\]/g, '');
  const excerpt = reply.length <= 550 ? reply : `${reply.slice(0, 300)}\n${reply.slice(-250)}`;
  return `${question}\n${excerpt}`;
}

async function indexHistory(pipe, store, chat, beforeId, currentChatOnly, limit, signal) {
  const missing = store.unindexedHistory(chat, beforeId, modelVersion, currentChatOnly, limit);
  for (let start = 0; start < missing.length && !signal?.aborted; start += 16) {
    const batch = missing.slice(start, start + 16);
    const vectors = (await encode(pipe, batch.map(memoryText))).tolist();
    store.saveHistoryVectors(modelVersion, batch.map(({ id }, index) => ({
      id, vector: Buffer.from(Float32Array.from(vectors[index]).buffer),
    })));
  }
}

let background = Promise.resolve();
export function indexRecentHistory(store, chat) {
  background = background.then(async () => {
    const pipe = await encoder();
    if (pipe) await indexHistory(pipe, store, chat, '', true, 8);
  }).catch(() => {});
}

export async function relatedHistory(store, chat, user, currentChatOnly, signal) {
  const pipe = await encoder();
  if (!pipe || signal.aborted) return [];
  const queryText = `Represent this sentence for searching relevant passages: ${user.body.slice(0, 800)}`;
  const query = (await encode(pipe, [queryText])).data;
  await indexHistory(pipe, store, chat, user.id, currentChatOnly, 144, signal);
  const best = [];
  for (const { id, vector } of store.historyVectors(chat, user.id, modelVersion, currentChatOnly)) {
    const values = new Float32Array(vector.buffer, vector.byteOffset, vector.byteLength / Float32Array.BYTES_PER_ELEMENT);
    if (values.length !== query.length) continue;
    let score = 0;
    for (let index = 0; index < query.length; index++) score += query[index] * values[index];
    if (score < 0.45 || (best.length === 6 && score <= best.at(-1).score)) continue;
    best.push({ id, score });
    best.sort((a, b) => b.score - a.score);
    if (best.length > 6) best.pop();
  }
  if (!best.length) return [];
  return best.filter(hit => hit.score >= best[0].score - 0.10).map(hit => hit.id);
}
