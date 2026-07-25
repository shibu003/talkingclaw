import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Brain } from './brain.ts';
import { config } from './config.ts';
import { Voice } from './voice.ts';

const voice = new Voice(config.tts);
try {
  await voice.ensureEngine();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const brain = new Brain({ systemPrompt: config.systemPrompt, model: config.model });
const rl = readline.createInterface({ input: stdin, output: stdout });

let closing = false;
async function shutdown(code: number): Promise<never> {
  closing = true;
  rl.close();
  await Promise.all([brain.close(), voice.dispose()]);
  process.exit(code);
}
rl.on('SIGINT', () => void shutdown(0));

const greeting = `おかえりなさい、${config.character.name}だよ。今日は何する?おしゃべりでも、開発の話でもいいよ。`;
console.log(`\n${config.character.name}> ${greeting}\n(exit で終了)\n`);
void voice.speak(greeting);

while (!closing) {
  let line: string;
  try {
    line = (await rl.question('あなた> ')).trim();
  } catch {
    break; // readline が閉じられた(Ctrl+C / Ctrl+D)
  }
  if (!line) continue;
  if (line === 'exit' || line === 'quit') break;

  voice.stop();
  try {
    // 文が生成された端から TTS に流して先行再生する
    const reply = await brain.ask(line, (sentence) => voice.enqueue(sentence));
    console.log(`${config.character.name}> ${reply}\n`);
    await voice.waitIdle();
  } catch (error) {
    console.error(`エラー: ${(error as Error).message}`);
  }
}

await shutdown(0);
