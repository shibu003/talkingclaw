// 非対話スモークテスト: AivisSpeech 疎通 → Brain 1往復 → 実際に音声再生。
// 実行: npm run smoke
import { Brain } from './brain.ts';
import { config } from './config.ts';
import { Voice } from './voice.ts';

const voice = new Voice(config.tts);
console.log('AivisSpeech version:', await voice.ensureEngine());

const brain = new Brain({ systemPrompt: config.systemPrompt, model: config.model });
const started = Date.now();
let firstSentenceMs = 0;
const reply = await brain.ask('こんにちは。ぼくの好きな色は青だよ。二文で自己紹介して。', (sentence) => {
  if (firstSentenceMs === 0) firstSentenceMs = Date.now() - started;
  voice.enqueue(sentence);
});
console.log(`初文まで ${firstSentenceMs}ms / 全文まで ${Date.now() - started}ms: ${reply}`);
if (!reply) throw new Error('返答が空でした');

// 2 往復目: セッションが文脈(青)を覚えているか + warm レイテンシ計測
const started2 = Date.now();
const recall = await brain.ask('ぼくの好きな色、なんだったか覚えてる?一文で答えて。');
console.log(`warm 応答 ${Date.now() - started2}ms / 文脈テスト: ${recall}`);
if (!recall.includes('青')) throw new Error(`文脈が継続していません: ${recall}`);

await voice.waitIdle();
await brain.close();
await voice.dispose();
console.log('smoke OK');
process.exit(0);
