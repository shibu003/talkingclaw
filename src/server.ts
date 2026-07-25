// ブラウザ UI 用サーバ。音声認識(Web Speech API)はブラウザ側、音声合成はここで行い
// 文単位の WAV を SSE で通知してブラウザが順次再生する。
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Brain } from './brain.ts';
import { config } from './config.ts';
import { Voice } from './voice.ts';

const PORT = Number(process.env.PORT ?? 3300);
const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));

const voice = new Voice(config.tts);
console.log('AivisSpeech version:', await voice.ensureEngine());
const brain = new Brain({ systemPrompt: config.systemPrompt, model: config.model });

// ---- SSE 配信(接続前のイベントは history で追いつき、id で重複排除) ----
type Event =
  | { id: number; type: 'sentence'; text: string; audio: string | null }
  | { id: number; type: 'done'; text: string }
  | { id: number; type: 'error'; message: string };
const clients = new Set<ServerResponse>();
const history: Event[] = [];
let eventSeq = 0;

function broadcast(event: Omit<Event, 'id'>): void {
  const full = { id: ++eventSeq, ...event } as Event;
  history.push(full);
  if (history.length > 200) history.splice(0, history.length - 200);
  const payload = `data: ${JSON.stringify(full)}\n\n`;
  for (const client of clients) client.write(payload);
}

// ---- 合成済み WAV の置き場(ブラウザは /audio/<id> で取得) ----
const audioStore = new Map<number, Buffer>();
let audioSeq = 0;

async function toAudioUrl(text: string): Promise<string | null> {
  try {
    const wav = await voice.synthesizeWav(text);
    if (!wav) return null;
    const id = ++audioSeq;
    audioStore.set(id, wav);
    if (audioStore.size > 50) audioStore.delete(audioStore.keys().next().value as number);
    return `/audio/${id}`;
  } catch (error) {
    console.error(`音声合成エラー: ${(error as Error).message}`);
    return null; // 音声が作れなくてもテキストは届ける
  }
}

// ---- 相槌: 初文が遅い時に即再生してレイテンシを隠す(起動時に合成済み) ----
const fillerTexts = ['んー、えっとね。', 'ちょっと待ってね。', 'うーんとね。'];
const fillers: { text: string; audio: string | null }[] = [];
let fillerIndex = 0;

// 文を SSE + 音声にして順番どおり届ける(合成は並行、通知はキュー順)
let notifyQueue: Promise<void> = Promise.resolve();
function pushSentence(text: string): void {
  const audio = toAudioUrl(text);
  notifyQueue = notifyQueue.then(async () => {
    broadcast({ type: 'sentence', text, audio: await audio });
  });
}

let asking = false;
async function askAndBroadcast(text: string): Promise<void> {
  asking = true;
  let gotSentence = false;
  // 1.5 秒以内に初文が来なければ相槌でつなぐ
  const fillerTimer = setTimeout(() => {
    if (gotSentence || fillers.length === 0) return;
    const filler = fillers[fillerIndex++ % fillers.length];
    broadcast({ type: 'sentence', text: filler.text, audio: filler.audio });
  }, 1500);
  try {
    const reply = await brain.ask(text, (sentence) => {
      gotSentence = true;
      pushSentence(sentence);
    });
    await notifyQueue;
    broadcast({ type: 'done', text: reply });
  } catch (error) {
    broadcast({ type: 'error', message: (error as Error).message });
  } finally {
    clearTimeout(fillerTimer);
    asking = false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(htmlPath));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const event of history) res.write(`data: ${JSON.stringify(event)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
    const wav = audioStore.get(Number(url.pathname.slice('/audio/'.length)));
    if (!wav) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.end(wav);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/chat') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let text: string;
    try {
      text = String(JSON.parse(Buffer.concat(chunks).toString()).text ?? '').trim();
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'JSON body {text} が必要です' }));
      return;
    }
    if (!text) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'text が空です' }));
      return;
    }
    if (asking) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '前の返答を生成中です' }));
      return;
    }
    void askAndBroadcast(text);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, async () => {
  console.log(`talkingclaw web: http://localhost:${PORT}`);
  // 相槌を事前合成(以降は即時再生できる)
  for (const text of fillerTexts) fillers.push({ text, audio: await toAudioUrl(text) });
  // 挨拶を brain に作らせる = セッション warmup(初回のコールドスタートをここで消化)
  await askAndBroadcast('(ユーザーがブラウザで接続してきた。彼女らしく短く一言で挨拶して)');
  console.log('warmup 完了。会話できます。');
});
