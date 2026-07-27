// 第3の声(まい)のセットアップ(S7: daemon 起動と分離した同意フロー)
// 使い方: npm run setup-voice [-- --yes]
import { createInterface } from 'node:readline/promises';

const ENGINE = process.env.TTS_URL ?? 'http://127.0.0.1:10101';
const MODEL = {
  uuid: 'e9339137-2ae3-4d41-9394-fb757a7e61e6',
  name: 'まい',
  author: 'MAHOPROGRAM(魔法プログラム)',
  page: 'https://hub.aivis-project.com/aivm-models/e9339137-2ae3-4d41-9394-fb757a7e61e6',
  // AivisHub 公式ダウンロード URL 形式(S7: 既知 UUID 由来に固定)
  url: 'https://api.aivis-project.com/v1/aivm-models/e9339137-2ae3-4d41-9394-fb757a7e61e6/download?model_type=AIVMX',
};

const yes = process.argv.includes('--yes');

async function engineOk() {
  try { return (await fetch(`${ENGINE}/version`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}

if (!(await engineOk())) {
  console.error(`AivisSpeech Engine(${ENGINE})が起動していません。npm run web で部屋を立てるか engine を起動してから再実行してください`);
  process.exit(1);
}

const installed = await (await fetch(`${ENGINE}/aivm_models`)).json();
if (Object.keys(installed).includes(MODEL.uuid)) {
  console.log(`「${MODEL.name}」は導入済みです`);
} else {
  console.log(`音声モデルを AivisHub からダウンロードします:`);
  console.log(`  名前: ${MODEL.name} / 作者: ${MODEL.author}`);
  console.log(`  ライセンス: ACML 1.0(調査時点)。最新の利用条件は必ずモデルページで確認してください:`);
  console.log(`  ${MODEL.page}`);
  console.log(`  サイズ: 約 250MB(.aivmx はリポジトリに同梱しません)`);
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const a = (await rl.question('ダウンロードして導入しますか? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (a !== 'y' && a !== 'yes') { console.log('中止しました'); process.exit(0); }
  } else {
    console.log('--yes 指定のため同意済みとして進めます');
  }
  console.log('インストール中…(回線速度により数分)');
  const r = await fetch(`${ENGINE}/aivm_models/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ url: MODEL.url }),
  });
  if (r.status !== 204 && !r.ok) { console.error(`インストール失敗: ${r.status} ${await r.text()}`); process.exit(1); }
  console.log('インストール完了。ロードします…');
  await fetch(`${ENGINE}/aivm_models/${MODEL.uuid}/load`, { method: 'POST' }).catch(() => {});
}

const speakers = await (await fetch(`${ENGINE}/speakers`)).json();
const mai = speakers.find((s) => s.name === MODEL.name);
if (mai) {
  console.log(`確認 OK: ${MODEL.name}(styles: ${mai.styles.map((x) => `${x.name}=${x.id}`).join(', ')})`);
  console.log(`agent 登録例: AGENT_NAME=マイ VOICE='まい/ノーマル' で MCP を登録してください`);
} else {
  console.error('speakers に現れません。engine の再起動が必要かもしれません');
  process.exit(1);
}
