// 声の部屋のブラウザ端末。描画は textContent のみ(S9 XSS 規律 — innerHTML 禁止)。
const TOKEN = document.querySelector('meta[name="room-token"]').content;
const BOOT = document.querySelector('meta[name="room-boot"]').content;
const log = document.getElementById('log');
const statusEl = document.getElementById('status');
const noticeEl = document.getElementById('notice');
const micBtn = document.getElementById('mic');
const textInput = document.getElementById('text');

let lastEventId = 0;
let replayBoundary = 0;   // hello の lastId 以前は replay(S1: 音声 enqueue しない)
// ---- 部屋分割: 作業部屋 / 雑談部屋(表示・音声は今いる部屋の分だけ。切替は #roomBtn)----
let currentChannel = 'work';
const ROOM_LABEL = { work: '🛠 作業部屋', chat: '💬 雑談部屋' };
let handsfree = false;
let listening = false;
let playing = false;
let currentAudio = null; // 6C: barge-in の duck/pause 対象
const audioQueue = [];    // { url, bubble, eventId }
// 自己音声棄却(SP3 実機で誤認を確認): 直近 8s に再生したテキストと一致する認識結果は捨てる
const recentPlayed = [];
function rememberPlayed(text) {
  if (!text) return;
  recentPlayed.push({ text: normText(text), at: performance.now() });
  while (recentPlayed.length > 8) recentPlayed.shift();
}
function normText(t) {
  return (t || '').toLowerCase().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[、。!?！?\s]/g, '');
}
function isEcho(finalText) {
  const n = normText(finalText);
  if (n.length < 2) return false;
  const now = performance.now();
  return recentPlayed.some((r) => now - r.at < 8000 && (r.text.includes(n) || n.includes(r.text)));
}

function setStatus(t) { statusEl.textContent = t; }
function notice(t) { noticeEl.style.display = 'block'; noticeEl.textContent = t; }

// ---- 会話の描画: 発話 1 件 = 1 行。文を連結しない ----
// 依頼(user_speech)は .turn ブロックを作り、同じ turnId の返答をその中に置く。
// turnId が 'none'/未定義の発話(実況・警告)は根に置いて、返答の列に混ぜない。
const turnBlocks = new Map(); // turnId → .turn 要素
let lastGroup = null;         // 直前の話者グループ { host, from }
const MAX_BLOCKS = 200;       // #log の直下に積む塊の上限(サーバ側 MAX_LOG=1000 に対応)

// >>> turnHostKey(pure: test/check-ui.mjs から取り出して単体で検査する)
// その発話をどのブロックに置くか。null = 根に置く(どの依頼にも属さない発話)
function turnHostKey(ev, existing) {
  const id = ev.turnId;
  if (!id || id === 'none') return null;
  if (ev.type === 'user_speech') return id;      // 依頼は必ずブロックを作る
  return existing.has(id) ? id : null;           // 返答は既にある依頼にだけぶら下がる
}
// <<< turnHostKey

function turnHost(ev) {
  const key = turnHostKey(ev, turnBlocks);
  if (key === null) return log;
  let el = turnBlocks.get(key);
  if (el && log.contains(el)) return el;
  el = document.createElement('div');
  el.className = 'turn';
  log.appendChild(el);
  turnBlocks.set(key, el);
  return el;
}

function timeLabel(iso) {
  const d = new Date(iso ?? '');
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
}
// 話者ごとに固定の色(誰の発言かを名前を読まずに判別できるように)
function speakerHue(from) {
  let h = 7;
  for (const c of String(from)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// 1 発話 = 1 行。同じ話者が続く時は見出しを出さず行だけ足す(連結はしない)
function addLine(host, from, name, text, at) {
  if (!lastGroup || lastGroup.host !== host || lastGroup.from !== from || !log.contains(host)) {
    const spk = document.createElement('div');
    spk.className = 'spk' + (from === 'user' ? ' me' : '');
    const tm = document.createElement('span');
    tm.className = 'tm';
    tm.textContent = timeLabel(at);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name || from;
    if (from !== 'user') nm.style.color = `hsl(${speakerHue(from)} 72% 80%)`;
    spk.append(tm, nm);
    host.appendChild(spk);
    lastGroup = { host, from, spk };
  }
  const line = document.createElement('div');
  line.className = 'tx';
  setTextWithLinks(line, text);
  host.appendChild(line);
  trimLog();
  log.scrollTop = log.scrollHeight;
  return line;
}

// 本文中の URL だけをリンクにする。innerHTML は使わず、文字は textContent のまま置く(S9 規律)
function setTextWithLinks(el, text) {
  const src = String(text ?? '');
  const re = /https?:\/\/[^\s、。」）)]+/g;
  let at = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > at) el.appendChild(document.createTextNode(src.slice(at, m.index)));
    const a = document.createElement('a');
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = m[0];
    el.appendChild(a);
    at = m.index + m[0].length;
  }
  if (at < src.length) el.appendChild(document.createTextNode(src.slice(at)));
}

// 送った添付を会話の中に出す。画像はそのまま絵で、それ以外は開けるボタンで
function renderSentFiles(host, files) {
  const box = document.createElement('div');
  box.className = 'att';
  for (const name of files) {
    const url = '/uploads/' + encodeURIComponent(name) + '?token=' + TOKEN;
    const shown = String(name).replace(/^\d+-/, '');
    if (artifactKind(shown) === 'image') {
      const img = document.createElement('img');
      img.className = 'shot';
      img.loading = 'lazy';
      img.alt = shown;
      img.src = url;
      img.onerror = () => img.remove();
      img.onclick = () => window.open(url);
      box.appendChild(img);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.textContent = '📎 ' + shown;
      box.appendChild(a);
    }
  }
  host.appendChild(box);
  log.scrollTop = log.scrollHeight;
}

// 古い塊から捨てる(読み上げ中・再生待ちの行は残す)。ブラウザ側に上限が無かった
function trimLog() {
  while (log.children.length > MAX_BLOCKS) {
    const first = log.firstElementChild;
    if (!first || first === interimEl) break;
    if (first.classList.contains('speaking') || first.querySelector('.speaking')) break;
    if (audioQueue.some((j) => j.bubble && first.contains(j.bubble))) break;
    first.remove();
  }
  for (const [id, el] of turnBlocks) if (!log.contains(el)) turnBlocks.delete(id);
  if (lastGroup && !log.contains(lastGroup.host)) lastGroup = null;
}

function addSys(text) {
  const div = document.createElement('div');
  div.className = 'sys';
  div.textContent = text;
  log.appendChild(div);
  lastGroup = null;
  trimLog();
  log.scrollTop = log.scrollHeight;
}

// ---- 再生(audio 要素 = AEC 維持)----
function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-room-token': TOKEN },
    body: JSON.stringify(body),
  });
}

function playNext() {
  if (gateActive() && audioQueue.length > 0) { // 発話中はゲート(解除後に再開)
    setTimeout(playNext, 250);
    return;
  }
  const next = audioQueue.shift();
  if (!next) {
    playing = false;
    document.querySelectorAll('.speaking').forEach((el) => el.classList.remove('speaking'));
    setTimeout(resumeMic, 500); // エコー尾の拾い込み防止
    return;
  }
  playing = true;
  pauseMic();
  rememberPlayed(next.text);
  next.bubble.classList.add('speaking');
  const audio = new Audio(next.url + '?token=' + TOKEN); // S1: token 付与はブラウザ側
  currentAudio = audio;
  let advanced = false;
  const advance = () => {
    if (advanced) return;
    advanced = true;
    next.bubble.classList.remove('speaking');
    if (next.eventId) void post('/played', { eventId: next.eventId }); // S10/S4 計測・floor 用
    playNext();
  };
  audio.onended = audio.onerror = advance;
  audio.onplaying = () => { if (next.eventId) void post('/metrics', { kind: 'play_started', ms: 0, eventId: next.eventId }); };
  audio.play().catch(advance);
}

function enqueueAudio(url, bubble, eventId, turnId, filler, text) {
  audioQueue.push({ url, bubble, eventId, turnId, filler, text });
  if (!playing) playNext();
}

// 相槌の即時再生(queue を経由しない。終了後に通常 queue を再開)。
// 発話中(gateActive)なら解除待ちで少し保留し、それでも既に何か再生中なら諦める(即時性が価値の filler なので遅延して出す意味は薄い)。
function maybePlayAck(url, bubble, eventId, text) {
  if (playing) return;
  if (gateActive()) { setTimeout(() => maybePlayAck(url, bubble, eventId, text), 250); return; }
  playAckNow(url, bubble, eventId, text);
}
function playAckNow(url, bubble, eventId, text) {
  playing = true;
  pauseMic(); // マイク方針は SP3 の実測で確定(現状は保守的に停止)
  rememberPlayed(text);
  bubble.classList.add('speaking');
  const audio = new Audio(url + '?token=' + TOKEN);
  currentAudio = audio;
  let advanced = false;
  const advance = () => {
    if (advanced) return;
    advanced = true;
    bubble.classList.remove('speaking');
    if (eventId) void post('/played', { eventId });
    playNext(); // 通常 queue の続きへ(空なら resumeMic される)
  };
  audio.onended = audio.onerror = advance;
  audio.onplaying = () => { if (eventId) void post('/metrics', { kind: 'play_started', ms: 0, eventId }); };
  audio.play().catch(advance);
}

// 読み上げを止める。声で割り込んだ時とボタンで押した時で同じ後始末を通す
// (画面の行は消さない。消えるのは音だけ)
function stopSpeaking() {
  if (currentAudio) currentAudio.pause();
  audioQueue.length = 0;
  playing = false;
  document.querySelectorAll('.speaking').forEach((el) => el.classList.remove('speaking'));
}

// ---- SSE ----
let es = null;
function connect() {
  es = new EventSource('/events?token=' + TOKEN + '&after=' + lastEventId);
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'hello') {
      if (ev.bootId !== BOOT) return restartDetected();
      if (replayBoundary === 0) replayBoundary = ev.lastId;
      setStatus(handsfree ? '聞いてるよ' : '🎤 でハンズフリー開始');
      return;
    }
    if (ev.id <= lastEventId) return;
    lastEventId = ev.id;
    render(ev);
  };
  es.onerror = () => {
    setStatus('再接続中…');
    void checkRestart();
  };
}

function render(ev) {
  const isReplay = ev.id <= replayBoundary;
  // 部屋分割: 会話系(user_speech/agent_speech)は今いる部屋の分だけ表示・再生。
  // 実況/system・presence は channel を持たず常時表示(部屋切替の告知等は見えていてほしい)
  if ((ev.type === 'user_speech' || ev.type === 'agent_speech') && ev.channel && ev.channel !== currentChannel) return;
  if (ev.type === 'user_speech') {
    if (!isReplay) lastUserSpokeAt = performance.now();
    // 短い相槌(「うん」等)では溜まった読み上げを捨てない。長い発話 = 話題転換とみなして捨てる
    if (!isReplay && (ev.text ?? '').length >= 8) audioQueue.length = 0;
    addLine(turnHost(ev), 'user', 'あなた', ev.text ?? '', ev.at);
    if ((ev.files ?? []).length > 0) renderSentFiles(lastGroup?.host ?? log, ev.files);
    if (ev.targets && ev.targets.length > 0 && lastGroup) {
      const to = document.createElement('span');
      to.className = 'to';
      const names = ev.targets.map((t) => pidNames.get(t) ?? t);
      to.textContent = '→ ' + (ev.targets.length > 2 ? 'みんな' : names.join('・'));
      lastGroup.spk.appendChild(to);
    }
  } else if (ev.type === 'agent_speech') {
    const line = addLine(turnHost(ev), ev.from, ev.name, ev.text ?? '', ev.at);
    if (ev.audio && !isReplay) {
      // S6: 相槌(ack)は FIFO に入れない独立即時スロット — 再生中なら即スキップ
      if (ev.filler === 'ack') maybePlayAck(ev.audio, line, ev.id, ev.text);
      else enqueueAudio(ev.audio, line, ev.id, ev.turnId, ev.filler, ev.text);
      // 6B: 本応答が来たら同 turn の未再生 filler を破棄(キャンセル 3 層目)
      if (!ev.filler && ev.turnId) {
        for (let i = audioQueue.length - 1; i >= 0; i--) {
          if (audioQueue[i].filler && audioQueue[i].turnId === ev.turnId) audioQueue.splice(i, 1);
        }
      }
    }
  } else if (ev.type === 'system' || ev.type === 'presence') {
    addSys((ev.name ? ev.name + ': ' : '') + (ev.text ?? ev.type));
    if (ev.type === 'presence' && typeof refreshRoster === 'function') setTimeout(() => refreshRoster(), 100);
  }
  // 部屋で何か起きた = 作業の状態も変わっている可能性。進捗表示をすぐ取り直す
  boardSoon();
  if (gameKind !== null || sideView === 'game') setTimeout(() => void refreshGame(), 200);
}

// ---- daemon 再起動検出(S8: EventSource は 401 を読めない → 無認証 /health を poll)----
let restartPolling = false;
async function checkRestart() {
  if (restartPolling) return;
  restartPolling = true;
  try {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch('/health');
        const h = await r.json();
        if (h.bootId && h.bootId !== BOOT) return restartDetected();
        break; // 同一 bootId = 一時切断 → EventSource の自動再接続に任せる
      } catch { /* daemon down 中は待つ */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally { restartPolling = false; }
}

function restartDetected() {
  notice('部屋が再起動したよ。読み込み直すね…');
  setTimeout(() => location.reload(), 800); // reload で新 token を再取得(S8)
}

// ---- 発話送信 ----
async function send(text) {
  text = text.trim();
  if (!text) return;
  if (handleNav(text)) return; // 音声ナビ: 画面移動の指示は会話に流さず、その場で画面を動かす
  setStatus('届けたよ');
  try {
    const res = await post('/chat', { text, files: attached.map((a) => a.name) });
    attached.length = 0;
    renderAttached();
    if (res.status === 401) return void checkRestart();
    if (!res.ok) addSys('送信エラー: ' + res.status);
  } catch { addSys('サーバに繋がらないみたい'); }
}
// ---- こちらから画像・ファイルを送る(📎 / ドラッグ&ドロップ / 貼り付け)----
// 送り先は ~/.talkingclaw/uploads。作業先の git を汚さない場所に置いて、agent には実パスで渡す
const attached = [];              // { name, localName, url }
const attachedEl = document.getElementById('attached');
const composerEl = document.getElementById('composer');
const fileInput = document.getElementById('fileInput');
const uploadUrl = (name) => '/uploads/' + encodeURIComponent(name) + '?token=' + TOKEN;

function renderAttached() {
  attachedEl.replaceChildren();
  for (const a of attached) {
    const chip = document.createElement('button');
    chip.title = '押すと外すよ';
    if (artifactKind(a.localName) === 'image') {
      const img = document.createElement('img');
      img.src = uploadUrl(a.name);
      img.alt = '';
      img.onerror = () => img.remove();
      chip.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = a.localName;
    chip.appendChild(label);
    const x = document.createElement('span');
    x.textContent = '✕';
    chip.appendChild(x);
    chip.onclick = () => { attached.splice(attached.indexOf(a), 1); renderAttached(); };
    attachedEl.appendChild(chip);
  }
}

async function attachFiles(files) {
  for (const f of [...files].slice(0, 8)) {
    if (attached.length >= 8) { addSys('添付は 8 個までだよ'); break; }
    try {
      const r = await fetch('/upload?name=' + encodeURIComponent(f.name), {
        method: 'POST', headers: { 'x-room-token': TOKEN }, body: f,
      });
      const d = await r.json();
      if (!r.ok) { addSys(d.error ?? '送れなかった'); continue; }
      attached.push({ name: d.name, localName: f.name, url: uploadUrl(d.name) });
    } catch { addSys('サーバに繋がらないみたい'); }
  }
  renderAttached();
  textInput.focus();
}

document.getElementById('attachBtn').onclick = () => fileInput.click();
document.getElementById('stopBtn').onclick = () => {
  stopSpeaking();
  resumeMic();
  setStatus('止めたよ');
};
fileInput.onchange = () => { void attachFiles(fileInput.files); fileInput.value = ''; };
for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (e) => { e.preventDefault(); composerEl.classList.add('drop'); });
}
document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) composerEl.classList.remove('drop'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  composerEl.classList.remove('drop');
  if (e.dataTransfer?.files?.length) void attachFiles(e.dataTransfer.files);
});
textInput.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length > 0) { e.preventDefault(); void attachFiles(files); }
});

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { void send(textInput.value); textInput.value = ''; }
});
document.getElementById('send').onclick = () => {
  void send(textInput.value); textInput.value = ''; textInput.focus();
};

// ---- 音声認識 + STT 計測(S10 gate ①: speechend→final Δt)----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let interimEl = null;
let speechEndAt = 0;
let interimUpdatedAt = 0; // interim ゲート(S6): 本応答の再生開始を保留(ack は対象外)
let interimStartedAt = 0;
// ユーザーが今話しているかを room daemon に報告する(単一の状態源 userSpeaking / server: room.ts)。
// 会話 Brain・外部 MCP agent 等、他参加者の音声出力はこれを見て発話中は先に進めない。
let lastSpeakingPingAt = 0;
function reportSpeaking(speaking) {
  lastSpeakingPingAt = performance.now();
  void post('/speech-state', { speaking });
}
function gateActive() {
  const now = performance.now();
  if (!interimUpdatedAt) return false;
  if (now - interimUpdatedAt > 1500) return false;   // 新鮮な interim のみ
  if (now - interimStartedAt > 4000) return false;   // 最大保持 4s
  return true;
}

if (!SR) {
  notice('このブラウザは音声認識に未対応。Chrome を使うか、テキスト入力してね。');
  micBtn.disabled = true;
} else {
  recognition = new SR();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.onstart = () => {
    listening = true;
    speechEndAt = 0; // 前セッションの stale 値で計測が汚れないようリセット
    micBtn.classList.add('listening');
    setStatus('聞いてるよ');
  };
  recognition.onspeechend = () => { speechEndAt = performance.now(); };
  let sttFails = 0; // 6D: network 等の連続失敗で指数 backoff(no-speech は即再開)
  let lastSttError = '';
  recognition.onend = () => {
    listening = false;
    interimUpdatedAt = 0;
    reportSpeaking(false); // final を経ずに終わる(no-speech 等)場合の保険
    micBtn.classList.remove('listening');
    interimEl?.remove(); interimEl = null;
    if (!handsfree || playing) return;
    let delay = 300;
    if (lastSttError === 'network' || lastSttError === 'service-not-allowed') {
      delay = Math.min(8000, 1000 * 2 ** sttFails);
      setStatus(`認識サービスに再接続中…(${Math.round(delay / 1000)}s)`);
    }
    lastSttError = '';
    setTimeout(() => { if (handsfree && !playing && !listening) startMic(); }, delay);
  };
  recognition.onerror = (e) => {
    lastSttError = e.error;
    if (e.error === 'network') sttFails++;
    else if (e.error !== 'no-speech') sttFails = 0;
    if (e.error === 'not-allowed') { handsfree = false; micBtn.classList.remove('on'); setStatus('マイクが許可されていないよ'); }
  };
  recognition.onresult = (e) => {
    let finalText = '', interim = '';
    for (const r of e.results) (r.isFinal ? (finalText += r[0].transcript) : (interim += r[0].transcript));
    if (interim) {
      const now = performance.now();
      if (!interimUpdatedAt || now - interimUpdatedAt > 1500) interimStartedAt = now;
      interimUpdatedAt = now;
      // 発話継続中は 800ms 間隔で refresh(server 側の自動失効 4s より十分短い)
      if (now - lastSpeakingPingAt > 800) reportSpeaking(true);
      if (!interimEl) { interimEl = document.createElement('div'); interimEl.className = 'interim'; }
      interimEl.textContent = interim + '…';
      log.appendChild(interimEl);
      log.scrollTop = log.scrollHeight;
    }
    if (finalText) {
      sttFails = 0;
      interimUpdatedAt = 0; // final で即クリア(S6)
      reportSpeaking(false);
      if (isEcho(finalText)) {
        interimEl?.remove(); interimEl = null;
        addSys('(自分の声っぽいので無視したよ)');
        speechEndAt = 0;
        return;
      }
      if (speechEndAt > 0) { // gate ① 計測(15s 超は計測異常として捨てる)
        const delay = Math.round(performance.now() - speechEndAt);
        if (delay < 15_000) void post('/metrics', { kind: 'stt_final_delay', ms: delay });
        speechEndAt = 0;
      }
      interimEl?.remove(); interimEl = null;
      void send(finalText);
    }
  };
}

function startMic() { try { recognition.start(); } catch { /* already */ } }
function pauseMic() { if (recognition && listening) recognition.abort(); }
function resumeMic() { if (handsfree && !listening) startMic(); setStatus(handsfree ? '聞いてるよ' : '🎤 でハンズフリー開始'); }

// ---- 6C barge-in: VAD(silero v5・自前配信)で再生中の割込みを検知 ----
// duck(音量 0.15)→ 250ms 継続で確定: 再生停止 + 未再生破棄 + 認識再開(S11:
// 未合成テキスト・タスクは無傷。timeline はそのまま)
let vadInstance = null;
let bargeTimer = null;
async function ensureVad() {
  if (vadInstance || !window.vad) return;
  try {
    vadInstance = await window.vad.MicVAD.new({
      baseAssetPath: '/vad/',
      onnxWASMBasePath: '/vad/',
      model: 'v5',
      onSpeechStart: () => {
        if (!playing || !currentAudio) return;
        currentAudio.volume = 0.15; // duck
        bargeTimer = setTimeout(() => {
          if (!playing || !currentAudio) return;
          // 本物の発話だけで止める: STT の interim が来ていなければ自分たちの声/雑音とみなして戻す
          if (!interimUpdatedAt || performance.now() - interimUpdatedAt > 1200) {
            currentAudio.volume = 1;
            return;
          }
          stopSpeaking();                 // 再生中は pause、未再生は破棄(S11)
          void post('/metrics', { kind: 'barge_in', ms: 0 });
          setStatus('どうぞ');
          resumeMic();                    // 発話を拾いに行く
        }, 250);
      },
      onVADMisfire: () => {
        if (bargeTimer) { clearTimeout(bargeTimer); bargeTimer = null; }
        if (currentAudio) currentAudio.volume = 1;
      },
      onSpeechEnd: () => {
        if (bargeTimer) { clearTimeout(bargeTimer); bargeTimer = null; }
        if (playing && currentAudio) currentAudio.volume = 1;
      },
    });
    vadInstance.start();
  } catch (e) { console.warn('VAD 初期化失敗(barge-in なしで継続):', e); }
}

micBtn.addEventListener('click', () => {
  handsfree = !handsfree;
  micBtn.classList.toggle('on', handsfree);
  if (handsfree) { startMic(); void ensureVad(); }
  else { pauseMic(); setStatus('🎤 でハンズフリー開始'); }
});

// ---- 在室リスト + 相手選択(4A-2)----
const rosterEl = document.getElementById('roster');
let lastBoardRows = []; // 在室チップに「何をしているか」を出すための直近の作業状況
let selectedPid = null;
const pidNames = new Map();
const pidRooms = new Map(); // 誰がどの部屋にいるか(部屋一覧に出す)
async function refreshRoster() {
  try {
    const r = await fetch('/participants?token=' + TOKEN);
    const d = await r.json();
    selectedPid = d.selected;
    if (d.channel && d.channel !== currentChannel) { currentChannel = d.channel; updateRoomBtn(); }
    rosterEl.replaceChildren();
    // 相手が 1 人(クロエだけ)の時は選ぶ余地が無いので、行ごと隠して画面を軽くする
    rosterEl.classList.toggle('hidden', d.participants.length <= 1 && selectedPid === null);
    if (wideLayout()) void renderRooms();   // 部屋一覧の顔ぶれを合わせる
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = '話す相手:';
    rosterEl.appendChild(label);
    const auto = document.createElement('span');
    auto.className = 'chip active' + (selectedPid === null ? ' selected' : '');
    auto.textContent = 'みんな(自動)';
    auto.onclick = async () => { await post('/select', { participantId: null }); void refreshRoster(); };
    rosterEl.appendChild(auto);
    for (const p of d.participants) {
      pidNames.set(p.participantId, p.name);
      if (p.room) pidRooms.set(p.participantId, p.room);
      const chip = document.createElement('span');
      chip.className = 'chip ' + (p.presence === 'gone' ? 'gone' : 'active') + (p.participantId === selectedPid ? ' selected' : '');
      // 別の部屋にいる相手はグレー。押すと「呼ぶ?」を出す(いきなり動かさない)
      const elsewhere = p.room != null && p.room !== currentChannel;
      chip.classList.toggle('away', elsewhere);
      const job = lastBoardRows.find((t) => t.status === 'working' && t.agentName === p.name);
      chip.textContent = p.name + (p.voice !== 'ready' ? '(声なし)' : '');
      if (elsewhere) {
        const where = document.createElement('span');
        where.className = 'where';
        where.textContent = roomLabel(p.room).replace(/^[^\p{L}]+/u, '');
        chip.appendChild(where);
      }
      if (job) {
        const busy = document.createElement('span');
        busy.className = 'busy';
        busy.textContent = '作業中';
        chip.appendChild(busy);
        chip.title = job.request ?? '';
      }
      chip.onclick = async () => {
        if (elsewhere) return askInvite(p);   // 別の部屋にいる = まず呼ぶかどうか
        const next = selectedPid === p.participantId ? null : p.participantId;
        await post('/select', { participantId: next });
        void refreshRoster();
      };
      rosterEl.appendChild(chip);
    }
  } catch { /* 次の更新で */ }
}
// 別の部屋にいる相手を呼ぶかどうかを、その場で選ばせる(勝手に動かさない)
function askInvite(p) {
  const box = document.createElement('span');
  box.className = 'invite';
  const q = document.createElement('span');
  q.textContent = `${p.name} は${roomLabel(p.room)}にいるよ。呼ぶ?`;
  const yes = document.createElement('button');
  yes.className = 'tact';
  yes.textContent = '呼ぶ';
  yes.onclick = async () => {
    const r = await post('/invite', { participantId: p.participantId });
    if (!r.ok) addSys('呼べなかった');
    else addSys(`${p.name} を${roomLabel(currentChannel)}に呼んだよ`);
    void refreshRoster();
  };
  const no = document.createElement('button');
  no.className = 'tact';
  no.textContent = 'やめる';
  no.onclick = () => void refreshRoster();
  box.append(q, yes, no);
  rosterEl.appendChild(box);
}
setInterval(refreshRoster, 5000);
void refreshRoster();

// ---- W8-7: 成果物プレビュー(その場で見る)----
const previewEl = document.getElementById('preview');
const previewFrame = document.getElementById('previewFrame');
const previewTitle = document.getElementById('previewTitle');
const previewOpen = document.getElementById('previewOpen');
document.getElementById('previewClose').onclick = () => {
  previewEl.classList.remove('open');
  previewFrame.src = 'about:blank';
  if (sideView === 'artifact') openSide(false); // 見終わったら会話に場所を返す
};
// project = その作業がどのフォルダで行われたか(成果物はそこに出来る。既定は workspace)
function showPreview(relPath, project) {
  void post('/ui-state', { preview: relPath, board: boardOpen }); // W10-2: クロエが画面を把握できるように
  const url = '/files/' + encodeURIComponent(relPath).replace(/%2F/g, '/')
    + '?token=' + TOKEN + (project ? '&project=' + encodeURIComponent(project) : '');
  previewTitle.textContent = relPath + (project ? `(${project})` : '');
  previewOpen.href = url;
  previewFrame.src = url;
  previewEl.classList.add('open');
  openSide(true);
}

// 右レーン(成果物・報告・履歴)は常設しない。呼ばれた時だけ出して、閉じたら会話に場所を返す
function openSide(on) { document.body.classList.toggle('side-open', on); }
const previewedTasks = new Set();

// >>> artifactKind(pure: test/check-ui.mjs から取り出して単体で検査する)
// 「見て分かるもの」だけを成果物と呼ぶ(Claude の Artifact と同じ考え方)。
//   image = 会話にそのまま絵で出す / page = 開けば動くものとして見せる
//   file  = ソースや設定。これは成果物ではなく「さわったもの」— 一覧には出さない
function artifactKind(path) {
  const ext = (String(path).match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif'].includes(ext)) return 'image';
  if (['.html', '.htm', '.pdf'].includes(ext)) return 'page';
  return 'file';
}
function isViewable(path) { return artifactKind(path) !== 'file'; }
// <<< artifactKind

// 成果物の URL(S9: token はイベントに載せず、ここで付ける)
function fileUrl(relPath, project) {
  return '/files/' + encodeURIComponent(relPath).replace(/%2F/g, '/')
    + '?token=' + TOKEN + (project ? '&project=' + encodeURIComponent(project) : '');
}

// 画像の成果物。読めなければリンクに落とす(壊れた画像で場所を潰さない)
function shotOf(relPath, project, onFail) {
  const img = document.createElement('img');
  img.className = 'shot';
  img.loading = 'lazy';
  img.alt = relPath;
  img.src = fileUrl(relPath, project);
  img.onerror = () => { img.remove(); onFail?.(); };
  img.onclick = () => showPreview(relPath, project);
  return img;
}

function fileChip(relPath, project, label) {
  const a = document.createElement('a');
  a.href = fileUrl(relPath, project);
  a.textContent = (label ?? '📄 ') + relPath;
  a.onclick = (e) => { e.preventDefault(); showPreview(relPath, project); };
  return a;
}

// 記録に混ざる末尾の区切り(古い「成果物: a, b」行の名残)を落とす
function cleanPath(raw) { return String(raw).replace(/[,、.]+$/, '').trim(); }

// ---- パネル(部屋 / 作業ボード / 設定)。開くのは同時に 1 枚だけ ----
// 広い画面では左右のレーンに常設される(CSS 側の三分割)ので、開閉は狭い画面だけの話になる。
const wideQuery = matchMedia('(min-width: 1100px)');
const wideLayout = () => wideQuery.matches;
const boardEl = document.getElementById('boardList');
let boardOpen = wideLayout(); // 右レーン常設中は「開いている」— 描画を止めない
const panels = {
  rooms: { el: document.getElementById('rooms'), btn: document.getElementById('roomBtn'), render: renderRooms },
  board: { el: document.getElementById('board'), btn: document.getElementById('boardBtn'), render: refreshBoard },
  settings: { el: document.getElementById('settings'), btn: document.getElementById('settingsBtn'), render: renderSettings },
};
let openedPanel = null;
function openPanel(name) {
  openedPanel = openedPanel === name ? null : name;
  for (const [key, p] of Object.entries(panels)) {
    const on = key === openedPanel;
    p.el.classList.toggle('open', on);
    p.btn.setAttribute('aria-expanded', String(on));
  }
  boardOpen = wideLayout() || openedPanel === 'board';
  if (openedPanel) void panels[openedPanel].render();
}
for (const [key, p] of Object.entries(panels)) {
  p.btn.onclick = () => {
    // 広い画面の 📋 は「右レーンを出す/しまう」ボタン(パネル開閉は狭い画面の話)
    if (key === 'board' && wideLayout()) return openSide(!document.body.classList.contains('side-open'));
    openPanel(key);
  };
}
// 幅が変わってレーン ⇄ 1 カラムを跨いだら、開閉状態を揃え直す(レイアウト自体は CSS が持つ)
wideQuery.addEventListener('change', () => { openPanel(null); void renderSideAlways(); void refreshBoard(); });
// 広い画面ではパネルを開かなくても見えている = 開いた時だけ描く作りでは中身が空になる
function renderSideAlways() { if (wideLayout()) { void renderRooms(); void renderSettings(); } }

document.getElementById('logBtn').onclick = () => window.open('/transcript.md?token=' + TOKEN + '&channel=' + currentChannel);
document.getElementById('archiveBtn').onclick = () => window.open('/archives.md?token=' + TOKEN);

// ---- 部屋の一覧と切替 ----
// 一覧は /channels があればそれを、無いサーバ(現行)は組み込みの 2 部屋で動く。
// 新規作成 / 名前変更の UI は #roomsExtra にぶら下げる。
const roomBtnName = document.querySelector('#roomBtn .rname');
let roomList = [{ channel: 'work', label: ROOM_LABEL.work }, { channel: 'chat', label: ROOM_LABEL.chat }];
function roomLabel(ch) { return roomList.find((r) => r.channel === ch)?.label ?? ROOM_LABEL[ch] ?? ch; }
function updateRoomBtn() { roomBtnName.textContent = roomLabel(currentChannel); }
async function fetchRooms() {
  try {
    const r = await fetch('/channels?token=' + TOKEN);
    if (!r.ok) return;
    const rows = (await r.json()).rooms;
    if (!Array.isArray(rows) || rows.length === 0) return;
    roomList = rows.map((c) => (typeof c === 'string'
      ? { channel: c, label: ROOM_LABEL[c] ?? c }
      : { channel: c.channel, label: c.label ?? c.name ?? ROOM_LABEL[c.channel] ?? c.channel }));
  } catch { /* 未対応サーバでは組み込みの 2 部屋のまま */ }
}
// 部屋を作る / 名前を変える(音声ナビからも押せるよう data-voice を付ける)
function renderRoomsExtra() {
  const box = document.getElementById('roomsExtra');
  box.replaceChildren();
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '部屋の名前(例: デザイン相談)';
  input.maxLength = 24;
  input.dataset.voice = 'room-name-input';
  const create = document.createElement('button');
  create.textContent = '＋ この名前で作る';
  create.className = 'go';
  create.dataset.voice = 'create-room';
  const rename = document.createElement('button');
  rename.textContent = '今の部屋の名前を変える';
  rename.dataset.voice = 'rename-room';
  const act = async (action) => {
    const label = input.value.trim();
    if (!label) { input.focus(); addSys('部屋の名前を入れてね'); return; }
    try {
      const r = await post('/rooms', { action, label, channel: currentChannel });
      const d = await r.json();
      if (!r.ok) { addSys(d.error ?? '部屋を操作できなかった'); return; }
      input.value = '';
      if (action === 'create') { await renderRooms(); await enterRoom(d.channel); }
      else { await renderRooms(); updateRoomBtn(); }
    } catch { addSys('サーバに繋がらないみたい'); }
  };
  create.onclick = () => void act('create');
  rename.onclick = () => void act('rename');
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) void act('create'); };
  const row = document.createElement('div');
  row.className = 'rform';
  row.append(input, create, rename);
  box.appendChild(row);
}

async function renderRooms() {
  await fetchRooms();
  updateRoomBtn();
  renderRoomsExtra();
  const list = document.getElementById('roomList');
  list.replaceChildren();
  for (const room of roomList) {
    const btn = document.createElement('button');
    btn.className = 'room' + (room.channel === currentChannel ? ' here' : '');
    const main = document.createElement('span');
    main.className = 'rmain';
    const name = document.createElement('b');
    name.textContent = room.label;
    main.appendChild(name);
    // その部屋に誰がいて、何が起きているか(部屋を選ぶ材料になる)
    const who = [...pidRooms].filter(([, ch]) => ch === room.channel).map(([pid]) => pidNames.get(pid) ?? '');
    const sub = document.createElement('span');
    sub.className = 'rsub';
    sub.textContent = who.filter(Boolean).join('・') || 'クロエ';
    main.appendChild(sub);
    btn.appendChild(main);
    if (room.channel === currentChannel) {
      const mark = document.createElement('span');
      mark.className = 'here-mark';
      mark.textContent = 'いまここ';
      btn.appendChild(mark);
    } else if (gameKind && room.channel === 'game') {
      const mark = document.createElement('span');
      mark.className = 'rbadge';
      mark.textContent = '遊び中';
      btn.appendChild(mark);
    }
    btn.onclick = () => void enterRoom(room.channel);
    list.appendChild(btn);
  }
}
async function enterRoom(next) {
  openPanel(null);
  // 遊ぶための部屋なので、入っている間は卓を出す(既にその部屋に居る時も効かせる)
  if (next === 'game' && wideLayout() && sideView !== 'game') switchBoardTab('game');
  if (next === currentChannel) return;
  await post('/channel', { channel: next });
  currentChannel = next;
  updateRoomBtn();
  log.replaceChildren();
  turnBlocks.clear();
  lastGroup = null;
  audioQueue.length = 0;
  await showHistory(next); // 切り替えた部屋の直近の会話を読み込む(白紙にしない)
  void refreshRoster();    // 誰がいるか
  boardSoon(50);           // 何をしているか
  void renderRooms();      // 部屋の名前(一覧とヘッダの表示)
  void refreshGame();      // 部屋ごとに別のゲームなので取り直す
}

// 部屋に入った時、その部屋で話していた内容を読み直す(音は鳴らさない)
async function showHistory(channel, lines = 40) {
  try {
    const d = await (await post('/transcript', { channel, lines })).json();
    const rows = d.lines ?? [];
    if (rows.length === 0) { addSys('この部屋はまだ会話がないよ'); return; }
    addSys(`— ここまでが ${roomLabel(channel)} の直近の会話 —`);
    // 履歴に turnId は残っていないので全部根に置く(推測でブロックを作らない)
    for (const r of rows) addLine(log, r.who === 'あなた' ? 'user' : 'history:' + r.who, r.who, r.text, r.at);
    lastGroup = null; // 履歴とライブの行をつなげない
    addSys('— ここから今 —');
    log.scrollTop = log.scrollHeight;
  } catch { addSys('履歴を読めなかった(📄 会話ログから見てね)'); }
}

// ---- 音声ナビ: 話すだけで画面を動かす(ボタンを押さなくていい)----
// 「部屋一覧見せて」「雑談部屋に行って」「履歴出して」「閉じて」等。会話に紛れて誤爆しないよう、
// 短い言い切り(14 字以内)か「見せて/開いて/行って」等の指示語がある時だけ拾う。
// >>> navIntent(pure: test/check-nav.mjs から取り出して単体で検査する)
function navIntent(text, rooms, people, hasPlan) {
  const t = (text || '').replace(/\s|[、。!?！?]/g, '');

  // 相談の締め: 案が画面に出ている間だけ「終わり」「それでいこう」等を確定の合図として受ける。
  // 案が無い時は普通の会話なので何も横取りしない。直しの言葉が混じっていたら確定しない。
  if (hasPlan && t.length <= 24) {
    if (/(やめ|中止|無し|キャンセル|取り下げ|忘れて|白紙)/.test(t)) return { kind: 'plan-cancel' };
    const revising = /(でも|けど|直し|なおし|変え|かえ|待っ|ちょっと|違う|ちがう|別の|もう一度|やり直)/.test(t);
    if (!revising && /(終わり|おわり|以上|それでいこう|これでいこう|それでいい|これでいい|いいよ|お願い|おねがい|進め|始め|はじめ|やって|やろう|やっちゃ|決まり|確定|ゴー|オッケー|おっけー|了解|大丈夫)/.test(t)) {
      return { kind: 'plan-confirm' };
    }
  }

  const verb = /(開い|ひらい|見せ|みせ|表示|出して|行っ|いっ|入っ|はいっ|移動|切り替え|きりかえ|戻|もど|閉じ|とじ|作っ|つくっ|作成|新し|変え|かえ|付け|つけ|変更|切って|オフ|オン|止め|やめ)/.test(t);
  const short = t.length <= 14;
  if (!verb && !short) return null;
  const has = (...words) => words.some((w) => t.includes(w));

  // 作る・名前を変える(部屋そのものを操作する言葉。部屋名の一致より先に見る)
  const named = (re) => t.match(re)?.[1]?.replace(/^(を|の|は)/, '').slice(0, 30) || null;
  if (has('新しい部屋', '新規部屋', '部屋を作', '部屋作', 'ルームを作', '部屋立て', '部屋を立て')) {
    return { kind: 'create', name: named(/(.+?)(って|という|っていう|の)(名前で)?(部屋|ルーム)を?(作|立)/) || named(/名前は(.+)$/) };
  }
  if (has('名前を', '名前は', '名前変え', '改名', 'リネーム')) {
    const name = named(/名前(?:を|は)(.+?)(に|へ)(して|変え|変更|し$)/) || named(/名前(?:を|は)(.+)$/);
    if (name) return { kind: 'rename', name };
    return { kind: 'rename', name: null };
  }

  if (has('閉じ', 'とじ', '消して', '戻って', 'もどって')) return { kind: 'close' };
  if (has('部屋一覧', '部屋の一覧', '部屋のリスト', '部屋リスト', 'どんな部屋', '部屋どれ')) return { kind: 'rooms' };
  if (has('アーカイブ', '過去ログ', '昔のログ')) return { kind: 'archive' };
  if (has('会話ログ', 'ログファイル', '全部のログ')) return { kind: 'logfile' };
  if (has('履歴', 'ログ', 'りれき')) return { kind: 'history' };
  if (has('成果物', 'プレビュー', 'できたやつ', '作ったやつ', '出来上がり')) return { kind: 'artifact' };
  if (has('ボード', 'タスク', '進捗', '作業状況')) return { kind: 'board' };
  if (has('設定', 'せってい')) return { kind: 'settings' };
  if (has('マイク', 'ハンズフリー')) {
    return { kind: 'mic', on: !has('切って', 'オフ', 'off', '止め', 'やめ', '消して') };
  }

  // 話し相手の指名(在室リストの操作)
  if (has('みんな') && verb) return { kind: 'speaker', participantId: null };
  for (const p of people || []) {
    if (p.name && t.includes(p.name) && /(と話|に話|に聞|と喋|に頼|呼んで|指名|に伝え)/.test(t)) {
      return { kind: 'speaker', participantId: p.participantId, name: p.name };
    }
  }

  // 部屋の名前で入室。まず正式名(「雑談部屋」)、次に語幹(「雑談」)+ 指示語
  const names = (rooms || []).map((r) => ({ channel: r.channel, name: (r.label || '').replace(/[^\p{L}\p{N}]/gu, '') }));
  for (const r of names) if (r.name && t.includes(r.name)) return { kind: 'enter', channel: r.channel };
  for (const r of names) {
    const stem = r.name.replace(/(部屋|ルーム)$/, '');
    if (verb && stem.length >= 2 && t.includes(stem)) return { kind: 'enter', channel: r.channel };
  }
  return null;
}
// <<< navIntent

// 部屋の作成 / 名前変更の操作部品は #roomsExtra に他機能が載せる。音声からも押せるように
// data-voice="create-room" / "rename-room" / "room-name-input" を付けてもらう約束(無ければ案内を出す)。
function voiceTarget(name) { return document.querySelector(`[data-voice="${name}"]`); }
function showPanelForce(name) {
  if (openedPanel !== name) openPanel(name);
  else void panels[name].render();
}

function handleNav(text) {
  const people = [...pidNames].map(([participantId, name]) => ({ participantId, name }));
  const intent = navIntent(text, roomList, people, planActive);
  if (!intent) return false;
  if (intent.kind === 'plan-confirm' || intent.kind === 'plan-cancel') {
    void planAction(intent.kind === 'plan-confirm' ? 'confirm' : 'cancel');
    return true;
  }
  if (intent.kind === 'close') {
    openPanel(null);
    previewEl.classList.remove('open');
    addSys('閉じたよ');
  } else if (intent.kind === 'rooms' || intent.kind === 'board' || intent.kind === 'settings') {
    // 「見せて」は常に開く方向(既に開いていても閉じない)。中身は開き直して最新に
    if (intent.kind === 'board') switchBoardTab('work');
    else showPanelForce(intent.kind);
    addSys({ rooms: '部屋の一覧を出したよ', board: '進行中の作業を出したよ', settings: '設定を出したよ' }[intent.kind]);
  } else if (intent.kind === 'history') {
    void showHistory(currentChannel); // 別タブは音声だと出せない(ポップアップ扱い)ので、その場に読み込む
  } else if (intent.kind === 'archive' || intent.kind === 'logfile') {
    const href = intent.kind === 'archive'
      ? '/archives.md?token=' + TOKEN
      : '/transcript.md?token=' + TOKEN + '&channel=' + currentChannel;
    const w = window.open(href);
    if (!w) addSysLink(intent.kind === 'archive' ? 'アーカイブはここから見てね' : '会話ログはここから見てね', href);
  } else if (intent.kind === 'artifact') {
    void showLatestArtifact();
  } else if (intent.kind === 'mic') {
    if (handsfree !== intent.on) micBtn.click();
    addSys(intent.on ? 'マイクつけたよ' : 'マイク切ったよ');
  } else if (intent.kind === 'speaker') {
    void (async () => {
      await post('/select', { participantId: intent.participantId });
      void refreshRoster();
      addSys(intent.participantId ? `${intent.name} に話しかける設定にしたよ` : 'みんな(自動)に戻したよ');
    })();
  } else if (intent.kind === 'create') {
    showPanelForce('rooms');
    const input = voiceTarget('room-name-input');
    if (intent.name && input) input.value = intent.name;
    const btn = voiceTarget('create-room');
    if (btn) { btn.click(); addSys(intent.name ? `「${intent.name}」で部屋を作るね` : '部屋を作る画面を出したよ'); }
    else { input?.focus(); addSys('部屋の一覧を出したよ(作成の操作はここに出るよ)'); }
  } else if (intent.kind === 'rename') {
    showPanelForce('rooms');
    const input = voiceTarget('room-name-input');
    if (intent.name && input) input.value = intent.name;
    const btn = voiceTarget('rename-room');
    if (btn) { btn.click(); addSys(intent.name ? `この部屋の名前を「${intent.name}」にするね` : '名前を変える画面を出したよ'); }
    else { input?.focus(); addSys('部屋の一覧を出したよ(名前の変更はここからだよ)'); }
  } else if (intent.kind === 'enter') {
    if (intent.channel === currentChannel) { openPanel(null); addSys('もうこの部屋にいるよ'); }
    else void enterRoom(intent.channel);
  }
  setStatus('画面を動かしたよ');
  return true;
}

// 「成果物見せて」: 直近で出来た成果物をその場のプレビューで開く
async function showLatestArtifact() {
  try {
    const d = await (await post('/tasks', {})).json();
    const rows = [...(d.tasks ?? []), ...(d.open ?? [])].filter((t) => (t.artifacts ?? []).length > 0);
    const last = rows[rows.length - 1];
    if (!last) { addSys('まだ成果物は無いよ'); return; }
    showPreview(last.artifacts[last.artifacts.length - 1], last.project);
  } catch { addSys('成果物を取れなかった'); }
}

// ポップアップが塞がれた時の逃げ道(音声からの window.open はブロックされる事がある)
function addSysLink(text, href) {
  const div = document.createElement('div');
  div.className = 'sys';
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.textContent = text;
  div.appendChild(a);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
updateRoomBtn();
const STAT_LABEL = { queued: '待機', working: '⚙ 作業中', done: '✔ 完了', failed: '✖ 失敗', interrupted: '⏸ 中断' };
// 経過時間(進捗率は誰も知らないので、代わりに「どれだけ経ったか」を出す)
function elapsed(iso) {
  const ms = Date.now() - new Date(iso ?? '').getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return `${Math.max(1, Math.floor(ms / 1000))}秒`;
  if (min < 60) return `${min}分`;
  return `${Math.floor(min / 60)}時間${min % 60}分`;
}

// >>> progressSummary(pure: test/check-ui.mjs から取り出して単体で検査する)
// 進捗の帯の元データ。割合は「件数」の実測だけで作る(作業中の進み具合は誰も知らないので
// 率をでっち上げず、帯は動くストライプ・タスク行は経過時間で表す)
function progressSummary(rows) {
  const counts = { working: 0, queued: 0, done: 0, failed: 0, interrupted: 0 };
  let note = '';
  for (const t of rows || []) {
    const s = counts[t.status] === undefined ? 'queued' : t.status;
    counts[s]++;
    if (s === 'working' && (t.notes ?? []).length > 0) note = `${t.agentName}: ${t.notes[t.notes.length - 1]}`;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 100));
  return {
    counts, total, note,
    // 帯の並び順 = 済んだもの → 動いているもの → これから
    bar: [
      { key: 'done', pct: pct(counts.done) },
      { key: 'failed', pct: pct(counts.failed + counts.interrupted) },
      { key: 'working', pct: pct(counts.working) },
      { key: 'queued', pct: pct(counts.queued) },
    ].filter((s) => s.pct > 0),
  };
}
// <<< progressSummary

// ---- 相談モード: まとまるまで作業は始まらない。案は画面に出して合図を待つ ----
// 音声からの確定も同じ道を通す: post('/plan', { action: 'confirm' })
const planEl = document.getElementById('plan');
let planActive = false; // 案が画面に出ている間だけ「終わり」等の合図を確定として受け取る
function renderPlan(p) {
  planActive = !!p;
  planEl.classList.toggle('on', !!p);
  if (!p) return;
  planEl.replaceChildren();
  const head = document.createElement('h3');
  head.textContent = '相談中の案(まだ始めてないよ)';
  const sum = document.createElement('div');
  sum.className = 'psummary';
  sum.textContent = p.summary;
  planEl.append(head, sum);
  if ((p.steps ?? []).length > 0) {
    const ol = document.createElement('ol');
    for (const s of p.steps) { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); }
    planEl.appendChild(ol);
  }
  const acts = document.createElement('div');
  acts.className = 'pacts';
  const go = document.createElement('button');
  go.className = 'go';
  go.textContent = 'これで始める';
  go.onclick = () => void planAction('confirm');
  const stop = document.createElement('button');
  stop.textContent = 'やめる';
  stop.onclick = () => void planAction('cancel');
  acts.append(go, stop);
  planEl.appendChild(acts);
  const hint = document.createElement('p');
  hint.className = 'tnote';
  hint.textContent = '声でもいいよ —「終わり」「それでいこう」で着手、「やめて」で取り下げ';
  planEl.appendChild(hint);
}
async function planAction(action) {
  try {
    const r = await post('/plan', { action });
    const d = await r.json();
    if (!r.ok) { addSys(d.error ?? '案を動かせなかった'); return; }
    renderPlan(null);
    addSys(action === 'confirm' ? 'この案で始めるね' : '案は取り下げたよ');
    boardSoon(100);
  } catch { addSys('サーバに繋がらないみたい'); }
}

const progressEl = document.getElementById('progress');
progressEl.onclick = () => switchBoardTab('work');   // 進行中は右の「作業」で見る
function renderProgress(rows) {
  const s = progressSummary(rows);
  boardActive = s.counts.working + s.counts.queued > 0; // 動いている間は更新を速く
  progressEl.classList.toggle('on', s.total > 0);
  if (s.total === 0) return;
  progressEl.replaceChildren();
  const bar = document.createElement('span');
  bar.className = 'pbar';
  for (const seg of s.bar) {
    const i = document.createElement('i');
    i.className = 's-' + seg.key;
    i.style.width = seg.pct + '%';
    bar.appendChild(i);
  }
  progressEl.appendChild(bar);
  const legend = document.createElement('span');
  legend.className = 'plegend';
  const items = [
    ['working', '作業中', s.counts.working], ['queued', '待機', s.counts.queued],
    ['done', '完了', s.counts.done], ['failed', '止まった', s.counts.failed + s.counts.interrupted],
  ];
  for (const [key, label, n] of items) {
    if (n === 0 && key !== 'working') continue;
    const item = document.createElement('span');
    const dot = document.createElement('i');
    dot.className = 's-' + key;
    const b = document.createElement('b');
    b.textContent = String(n);
    item.append(dot, document.createTextNode(label), b);
    legend.appendChild(item);
  }
  progressEl.appendChild(legend);
  if (s.note) {
    const note = document.createElement('span');
    note.className = 'pnote';
    note.textContent = '実況: ' + s.note;
    progressEl.appendChild(note);
  }
}

// ---- W12: 報告 INBOX(board パネルの 2 タブ目)----
const inboxEl = document.getElementById('inboxList');
const inboxCountEl = document.getElementById('inboxCount');
const boardBadgeEl = document.getElementById('boardBadge');
const artifactEl = document.getElementById('artifactList');
const historyEl = document.getElementById('historyList');
// 右レーンの 3 面。生きている一覧(成果物・報告)は短く保ち、
// 済んだものと全部の履歴は「履歴」に集める(ここだけは長くなってよい)
const gameEl = document.getElementById('gameList');
const worksEl = document.getElementById('tasks');
const SIDE_VIEWS = {
  artifact: [artifactEl, 'tabArtifact'], inbox: [inboxEl, 'tabInbox'],
  work: [worksEl, 'tabWork'], game: [gameEl, 'tabGame'],
};
let sideView = 'artifact';
let inboxTab = false; // 報告を見ている間は成果物一覧を描き直さない
for (const [name, [, btnId]] of Object.entries(SIDE_VIEWS)) {
  document.getElementById(btnId).onclick = () => switchBoardTab(name);
}
function switchBoardTab(view) {
  sideView = typeof view === 'string' ? view : (view ? 'inbox' : 'artifact');
  openSide(true);
  inboxTab = sideView !== 'artifact';
  for (const [name, [el, btnId]] of Object.entries(SIDE_VIEWS)) {
    el.hidden = name !== sideView;
    document.getElementById(btnId).classList.toggle('on', name === sideView);
  }
  void (sideView === 'inbox' ? refreshInbox() : sideView === 'game' ? refreshGame() : refreshBoard());
  document.body.classList.toggle('playing', gameKind !== null && sideView === 'game');
}

// ---- 幅を掴んで動かす(Zed のような仕切り)----
// 左は px、右は画面幅に対する % で覚える。両端に寄せすぎないよう幅に下限を置く
function setupGrips() {
  const saved = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 使えなくても動く */ } };
  const navW = saved('tc-nav-w');
  const sideW = saved('tc-side-w');
  if (navW) document.documentElement.style.setProperty('--nav-w', navW);
  if (sideW) document.documentElement.style.setProperty('--side-w', sideW);

  const make = (lane, onMove, onReset) => {
    if (!lane) return;
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'ドラッグで幅を変える(ダブルクリックで戻す)';
    grip.onpointerdown = (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('dragging');
      document.body.style.userSelect = 'none';
      const move = (ev) => onMove(ev.clientX);
      const up = () => {
        grip.classList.remove('dragging');
        document.body.style.userSelect = '';
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    };
    grip.ondblclick = onReset;
    lane.appendChild(grip);
  };

  make(document.querySelector('.lane.nav'), (x) => {
    const w = Math.round(Math.min(Math.max(x, 180), window.innerWidth * 0.4)) + 'px';
    document.documentElement.style.setProperty('--nav-w', w);
    remember('tc-nav-w', w);
  }, () => {
    document.documentElement.style.removeProperty('--nav-w');
    remember('tc-nav-w', '');
  });

  make(document.querySelector('.lane.side'), (x) => {
    const pct = Math.min(Math.max((window.innerWidth - x) / window.innerWidth * 100, 22), 65);
    const w = pct.toFixed(1) + '%';
    document.documentElement.style.setProperty('--side-w', w);
    remember('tc-side-w', w);
  }, () => {
    document.documentElement.style.removeProperty('--side-w');
    remember('tc-side-w', '');
  });
}
setupGrips();

// ---- ゲーム: 声で言えることは全部ボタンでも押せる ----
// ボタンは声とまったく同じ言葉を /chat に送るので、判定の入口が二重にならない
const gameBadgeEl = document.getElementById('gameBadge');
let gameKind = null;
async function refreshGame() {
  try {
    const v = await (await post('/game', {})).json();
    gameKind = v.kind;
    gameBadgeEl.textContent = v.kind ? '●' : '';
    if (sideView !== 'game') return;
    gameEl.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = v.title;
    gameEl.appendChild(h);
    if ((v.state ?? []).length > 0) {
      const st = document.createElement('div');
      st.className = 'gstate';
      for (const line of v.state) {
        const b = document.createElement('b');
        b.textContent = line;
        st.append(b, document.createElement('br'));
      }
      gameEl.appendChild(st);
    }
    document.getElementById('board').classList.toggle('playing', !!v.kind);
    document.body.classList.toggle('playing', !!v.kind && sideView === 'game');
    if (v.board) renderMahjongBoard(v.board);
    if ((v.hand ?? []).length > 0) {
      const lab = document.createElement('div');
      lab.className = 'grow-label';
      lab.textContent = 'あなたの手牌';
      gameEl.appendChild(lab);
      const box = document.createElement('div');
      box.className = 'gtiles';
      for (const f of v.hand) {
        const el = document.createElement(f.move ? 'button' : 'span');
        el.className = 'gtile' + (f.red ? ' drawn' : '') + (f.move ? ' can' : '');
        el.textContent = f.text;
        if (f.move) { el.title = '押すと切るよ'; el.onclick = () => void playMove(f.move); }
        box.appendChild(el);
      }
      gameEl.appendChild(box);
    }
    // 札と牌は実物として並べる。押せるもの(麻雀の打牌)はボタンになる
    for (const row of v.table ?? []) {
      const lab = document.createElement('div');
      lab.className = 'grow-label';
      lab.textContent = row.label;
      gameEl.appendChild(lab);
      const box = document.createElement('div');
      box.className = row.kind === 'card' ? 'gcards' : 'gtiles';
      for (const f of row.faces) {
        const el = document.createElement(f.move ? 'button' : 'span');
        el.className = (row.kind === 'card' ? 'gcard' : 'gtile')
          + (f.red ? ' red' : '') + (f.hidden ? ' back' : '') + (f.move ? ' can' : '');
        el.textContent = f.hidden ? '' : f.text;
        if (f.move) { el.title = '押すと切るよ'; el.onclick = () => void playMove(f.move); }
        box.appendChild(el);
      }
      gameEl.appendChild(box);
    }
    const moves = document.createElement('div');
    moves.className = 'gmoves';
    for (const m of v.moves ?? []) {
      const b = document.createElement('button');
      b.className = 'gmove' + (m.label.startsWith('🎉') ? ' hot' : '');
      b.textContent = m.label;
      b.onclick = () => void playMove(m.text);
      moves.appendChild(b);
    }
    gameEl.appendChild(moves);
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = 'ルール';
    const rules = document.createElement('div');
    rules.className = 'grules';
    rules.textContent = v.rules ?? '';
    det.append(sum, rules);
    gameEl.appendChild(det);
  } catch { /* 次の更新で */ }
}
// 麻雀の卓。自分から見た向きで 4 人ぶんの河を並べる(本物の卓と同じ配置)
function renderMahjongBoard(b) {
  const t = document.createElement('div');
  t.className = 'mjtable';

  for (const s of b.seats) {
    const cell = document.createElement('div');
    cell.className = 'mjseat at-' + s.at + (s.turn ? ' turn' : '');

    const who = document.createElement('div');
    who.className = 'mjwho';
    const wind = document.createElement('b');
    wind.className = 'mjwind' + (s.dealer ? ' dealer' : '');
    wind.textContent = s.wind;
    who.appendChild(wind);
    who.append(document.createTextNode(` ${s.name} ${s.points}`));
    if (s.riichi) {
      const r = document.createElement('span');
      r.className = 'mjriichi';
      r.textContent = 'リーチ';
      who.appendChild(r);
    }
    cell.appendChild(who);

    // 河は 6 枚ずつ 3 段。各家が自分の向きで捨てているので、その向きに回す
    const river = document.createElement('div');
    river.className = 'mjriver';
    for (const name of s.river.slice(-18)) {
      const el = document.createElement('span');
      el.className = 'rtile';
      el.textContent = name;
      river.appendChild(el);
    }
    const wrap = document.createElement('div');
    wrap.className = 'mjriverbox';
    wrap.appendChild(river);
    cell.appendChild(wrap);

    // 晒した面子(鳴いたもの)は誰にでも見えるので河のそばに出す
    if ((s.melds ?? []).length > 0) {
      const box = document.createElement('div');
      box.className = 'mjmelds';
      for (const meld of s.melds) {
        const set = document.createElement('span');
        set.className = 'mjmeld';
        for (const name of meld) {
          const el = document.createElement('span');
          el.className = 'rtile open';
          el.textContent = name;
          set.appendChild(el);
        }
        box.appendChild(set);
      }
      cell.appendChild(box);
    }
    t.appendChild(cell);
  }

  const center = document.createElement('div');
  center.className = 'mjcenter';
  const l1 = document.createElement('b');
  l1.textContent = `${b.round} ${b.honba}本場`;
  const l2 = document.createElement('span');
  l2.textContent = `ドラ ${b.dora}`;
  const l3 = document.createElement('span');
  l3.textContent = `残り ${b.left} 枚${b.sticks > 0 ? ` / 供託 ${b.sticks}` : ''}`;
  center.append(l1, l2, l3);
  t.appendChild(center);

  gameEl.appendChild(t);
}

// ボタンを押す = その言葉を言うのと同じ
async function playMove(text) {
  await post('/chat', { text, immediate: true });
  setTimeout(() => void refreshGame(), 400);
}

// 履歴: 済んだ作業を新しい順に。生きている一覧から外したものはここで必ず見つかる
function renderHistory(rows) {
  if (sideView !== 'work') return;
  const done = rows.filter((t) => t.status === 'done' || t.status === 'failed' || t.status === 'interrupted');
  historyEl.replaceChildren();
  const head = document.createElement('div');
  head.className = 'grow-label';
  head.textContent = '終わったもの';
  historyEl.appendChild(head);
  if (done.length === 0) {
    const e = document.createElement('div');
    e.className = 'tnote';
    e.textContent = 'まだ終わった作業はないよ';
    historyEl.appendChild(e);
    return;
  }
  for (const t of done) {
    const div = document.createElement('div');
    div.className = 'thread';
    const h = document.createElement('h3');
    h.textContent = (t.status === 'done' ? '✔ ' : '✖ ') + (t.report?.headline || (t.request ?? '').slice(0, 40));
    div.appendChild(h);
    const meta = document.createElement('div');
    meta.className = 'req';
    meta.textContent = `${t.agentName ?? ''} ・ ${elapsed(t.at)}前`;
    div.appendChild(meta);
    const files = document.createElement('div');
    files.className = 'files';
    for (const raw of t.artifacts ?? []) {
      const path = cleanPath(raw);
      if (path && isViewable(path)) files.appendChild(fileChip(path, t.project, artifactKind(path) === 'image' ? '🖼 ' : '▶ '));
    }
    if (files.children.length > 0) div.appendChild(files);
    h.prepend(pickBox(t.id, () => boardSoon(0)));
    historyEl.appendChild(div);
  }
  pickBar(historyEl, () => boardSoon(0));
}

// 遊べるものも「見て分かる成果物」なので、成果物タブから選んで始められるようにする。
// 選んだらゲーム部屋へ移動して卓を開く(遊ぶ場所に連れていく)
function playBox() {
  const box = document.createElement('div');
  box.className = 'playbox';
  const h = document.createElement('b');
  h.textContent = gameKind ? '遊んでいるゲーム' : '遊ぶ';
  box.appendChild(h);
  const row = document.createElement('div');
  row.className = 'gmoves';
  for (const [label, text, kind] of [
    ['🃏 ポーカー', 'ポーカーやろう', 'poker'],
    ['♠ ブラックジャック', 'ブラックジャックやろう', 'blackjack'],
    ['🀄 麻雀', '麻雀やろう', 'mahjong'],
  ]) {
    const b = document.createElement('button');
    b.className = 'gmove' + (gameKind === kind ? ' hot' : '');
    b.textContent = label;
    b.onclick = async () => {
      if (currentChannel !== 'game') await enterRoom('game'); // 遊ぶ部屋に移動する
      switchBoardTab('game');
      if (gameKind === kind) return;                          // もう遊んでいる = 卓を見せるだけ
      if (gameKind) { addSys('先に「やめる」で今のゲームを終わらせてね'); return; }
      await playMove(text);
    };
    row.appendChild(b);
  }
  box.appendChild(row);
  return box;
}

// 右レーンの成果物一覧(新しい順)。画像はサムネを付けて「何ができたか」を見せる
const ARTIFACT_SHOWN = 8; // レーンをスクロールさせないための上限
const TASKS_SHOWN = 2;
const THREADS_SHOWN = 4;
function renderArtifacts(rows) {
  if (inboxTab) return;
  const items = [];
  const seen = new Set();
  for (const t of rows) {
    for (const raw of t.artifacts ?? []) {
      const path = cleanPath(raw);
      const key = (t.project ?? '') + '|' + path;
      if (!path || !isViewable(path) || seen.has(key)) continue; // 見て分かるものだけが成果物
      seen.add(key);
      items.push({ path, project: t.project });
    }
  }
  artifactEl.replaceChildren();
  artifactEl.appendChild(playBox());
  if (items.length === 0) {
    const e = document.createElement('div');
    e.className = 'tnote';
    e.textContent = 'まだ見える成果物はないよ(直したファイルは「報告」のさわったものに出るよ)';
    artifactEl.appendChild(e);
    return;
  }
  // 一覧にせずボタンを並べる(縦に伸ばさない = スクロールしない)
  const box = document.createElement('div');
  box.className = 'files';
  for (const it of items.slice(0, ARTIFACT_SHOWN)) {
    box.appendChild(fileChip(it.path, it.project, artifactKind(it.path) === 'image' ? '🖼 ' : '▶ '));
  }
  artifactEl.appendChild(box);
  if (items.length > ARTIFACT_SHOWN) {
    const more = document.createElement('div');
    more.className = 'tnote';
    more.textContent = `ほかに ${items.length - ARTIFACT_SHOWN} 件は「履歴」で見てね`;
    artifactEl.appendChild(more);
  }
}

function threadCard(t) {
  const r = t.report ?? {};
  const div = document.createElement('div');
  div.className = 'thread' + (t.unread ? ' unread' : '');
  const h = document.createElement('h3');
  h.appendChild(pickBox(t.id, () => refreshInbox()));
  const stat = document.createElement('span');
  stat.className = 'tstat ' + (t.status ?? 'done');
  stat.textContent = STAT_LABEL[t.status] ?? '✔ 完了';
  h.append(stat, document.createTextNode(r.headline || t.request.slice(0, 40)));
  div.appendChild(h);
  const req = document.createElement('div');
  req.className = 'req';
  req.textContent = `依頼: 「${t.request.slice(0, 60)}」(${(t.at || '').slice(11, 16)})`;
  div.appendChild(req);
  const sec = (label, items, warn) => {
    if (!items || items.length === 0) return;
    const s = document.createElement('div');
    s.className = 'sec' + (warn ? ' warn' : '');
    const b = document.createElement('b');
    b.textContent = label;
    s.appendChild(b);
    const ul = document.createElement('ul');
    for (const it of items) { const li = document.createElement('li'); li.textContent = it; ul.appendChild(li); }
    s.appendChild(ul);
    div.appendChild(s);
  };
  sec('できるようになったこと', r.can);
  sec('確かめかた', r.check, (r.check ?? []).some((c) => c.includes('書き忘れ')));
  sec('やらなかったこと', r.skipped);
  if ((r.touched ?? []).length > 0) {
    const s = document.createElement('div');
    s.className = 'sec';
    const b = document.createElement('b'); b.textContent = 'さわったもの'; s.appendChild(b);
    const files = document.createElement('div');
    files.className = 'files';
    // 画像はここでも絵で見せる(報告と成果物で、同じものが同じように見えるように)
    for (const raw of r.touched) {
      const p = cleanPath(raw);
      if (!p) continue;
      if (artifactKind(p) === 'image') s.appendChild(shotOf(p, t.project, () => files.appendChild(fileChip(p, t.project, '🖼 '))));
      else files.appendChild(fileChip(p, t.project, artifactKind(p) === 'page' ? '▶ ' : '📄 '));
    }
    s.appendChild(files);
    div.appendChild(s);
  }
  const actions = document.createElement('div');
  actions.className = 'actions';
  const input = document.createElement('input');
  input.placeholder = 'この報告に返信(続けて直したいこと)';
  input.onkeydown = async (e) => {
    if (e.key !== 'Enter' || e.isComposing || !input.value.trim()) return;
    await post('/inbox/reply', { threadId: t.id, text: input.value.trim() });
    input.value = '';
    void refreshInbox();
  };
  actions.appendChild(input);
  if (t.unread) {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.textContent = '既読';
    btn.onclick = async () => { await post('/inbox/read', { threadId: t.id }); void refreshInbox(); };
    actions.appendChild(btn);
  }
  // どの部屋で頼まれた作業かに戻れるようにする(そこで会話の続きができる)
  if (t.channel && t.channel !== currentChannel) {
    const go = document.createElement('button');
    go.className = 'tab';
    go.textContent = `${roomLabel(t.channel)}へ`;
    go.onclick = async () => { await post('/inbox/read', { threadId: t.id }); await enterRoom(t.channel); };
    actions.appendChild(go);
  }
  const del = document.createElement('button');
  del.className = 'tab';
  del.textContent = '消す';
  del.onclick = async () => { await post('/inbox/delete', { threadId: t.id }); void refreshInbox(); boardSoon(50); };
  actions.appendChild(del);
  div.appendChild(actions);
  return div;
}

async function refreshInbox() {
  try {
    const d = await (await post('/inbox', {})).json();
    const unread = d.unread ?? 0;
    inboxCountEl.textContent = unread > 0 ? String(unread) : '';
    boardBadgeEl.textContent = unread > 0 ? String(unread) : '';   // 狭い画面の 📋 に付ける赤丸
    document.title = (unread > 0 ? `(${unread}) ` : '') + 'talkingclaw — 声の部屋';
    if (!inboxTab) return;
    inboxEl.replaceChildren();
    if ((d.threads ?? []).length === 0) {
      const e = document.createElement('div'); e.className = 'tnote'; e.textContent = 'まだ報告はないよ'; inboxEl.appendChild(e);
      return;
    }
    for (const t of d.threads.slice(0, THREADS_SHOWN)) inboxEl.appendChild(threadCard(t));
    pickBar(inboxEl, () => refreshInbox());
    if (d.threads.length > THREADS_SHOWN) {
      const more = document.createElement('div');
      more.className = 'tnote';
      more.textContent = `ほかに ${d.threads.length - THREADS_SHOWN} 件の報告があるよ`;
      inboxEl.appendChild(more);
    }
  } catch { /* 次の更新で */ }
}

async function refreshBoard() {
  if (boardBusy) return; // 取得が重ならないように(SSE 連打 + 定期更新)
  boardBusy = true;
  try {
    const r = await post('/tasks', {});
    const d = await r.json();
    const rows = [...(d.tasks ?? []), ...(d.open ?? [])];
    lastBoardRows = rows;
    renderProgress(rows);          // 帯はボードを開いていなくても常に最新に
    renderPlan(d.plan ?? null);    // 相談中の案(あれば)
    checkAutoPreview(d);           // 出来たものは会話に成果物カードで出す
    renderArtifacts(rows);         // 右レーンの成果物一覧(見えるものだけ)
    renderHistory(rows);           // 済んだものは履歴に集める
    if (!boardOpen) return;
    boardEl.replaceChildren();
    // スクロールさせないため、ここは「まだ動いているもの」だけ。
    // 済んだもの・取り消したもの・skip されたものは残さない(見たい時は「履歴」)
    const live = rows.filter((t) => t.status === 'queued' || t.status === 'working');
    if (live.length === 0) {
      const e = document.createElement('div'); e.className = 'tnote'; e.textContent = 'いまは作業なし'; boardEl.appendChild(e);
    }
    for (const t of live.slice(0, TASKS_SHOWN)) {
      const div = document.createElement('div');
      div.className = 'task';
      const stat = document.createElement('span');
      stat.className = 'tstat ' + t.status;
      stat.textContent = STAT_LABEL[t.status] ?? t.status;
      div.appendChild(stat);
      const req = document.createElement('span');
      req.className = 'treq';
      req.textContent = `${t.agentName}: ${(t.request ?? '').slice(0, 60)}`;
      div.appendChild(req);
      const ago = elapsed(t.at);
      if (ago) {
        const meta = document.createElement('span');
        meta.className = 'tmeta';
        meta.textContent = t.status === 'working' ? `経過 ${ago}` : `受付 ${ago}前`;
        div.appendChild(meta);
      }
      const bar = document.createElement('span');
      bar.className = 'tbar';
      const fill = document.createElement('i');
      fill.className = 's-' + ({ working: 'working', done: 'done', failed: 'failed', interrupted: 'failed' }[t.status] ?? 'queued');
      bar.appendChild(fill);
      div.appendChild(bar);
      if (t.notes && t.notes.length > 0) {
        const note = document.createElement('span');
        note.className = 'tnote';
        note.textContent = '実況: ' + t.notes[t.notes.length - 1];
        div.appendChild(note);
      }
      if (t.id) { stat.before(pickBox(t.id, () => boardSoon(0))); div.appendChild(taskActions(t)); }
      boardEl.appendChild(div); // 成果物は右レーンの一覧に出るので、ここでは繰り返さない
    }
    pickBar(boardEl, () => boardSoon(0));
    if (live.length > TASKS_SHOWN) {
      const more = document.createElement('div');
      more.className = 'tnote';
      more.textContent = `ほかに ${live.length - TASKS_SHOWN} 件動いてるよ`;
      boardEl.appendChild(more);
    }
  } catch { /* 次回 */ } finally {
    boardBusy = false;
    scheduleBoard(); // 次の更新を状況に合わせて予約(作業中は速く)
  }
}
// ---- 選んでまとめて操作する(会話以外の一覧に共通)----
// チェックを付けた分だけ「まとめる」「消す」が効く。選んでいない時は何も出さない
const picked = new Set();
function pickBox(id, onChange) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'pick';
  box.checked = picked.has(id);
  box.onclick = (e) => e.stopPropagation();
  box.onchange = () => { box.checked ? picked.add(id) : picked.delete(id); onChange?.(); };
  return box;
}
// 選択中の操作バー。空なら描かない(画面を無駄に使わない)
function pickBar(host, onDone) {
  if (picked.size === 0) return;
  const bar = document.createElement('div');
  bar.className = 'pickbar';
  const label = document.createElement('span');
  label.textContent = `${picked.size} 件えらんでるよ`;
  bar.appendChild(label);
  const run = async (action) => {
    const r = await post('/task', { action, taskIds: [...picked] });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) addSys(d.error ?? 'できなかった');
    else if (action === 'merge') addSys(`${d.merged} 件を 1 つにまとめたよ`);
    picked.clear();
    onDone();
  };
  // 1 件だけ選んでいる時は、その場で書き直せる(まとめては 2 件以上から)
  if (picked.size === 1) {
    const edit = document.createElement('button');
    edit.className = 'tact';
    edit.textContent = '直す';
    edit.onclick = () => {
      const id = [...picked][0];
      const input = document.createElement('input');
      input.className = 'tedit';
      input.placeholder = '書き直して Enter(Esc でやめる)';
      input.onkeydown = async (e) => {
        if (e.key === 'Escape') { picked.clear(); onDone(); return; }
        if (e.key !== 'Enter' || e.isComposing || !input.value.trim()) return;
        const r = await post('/task', { action: 'edit', taskId: id, text: input.value.trim() });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) addSys(d.error ?? '直せなかった');
        picked.clear();
        onDone();
      };
      bar.replaceChildren(input);
      input.focus();
    };
    bar.appendChild(edit);
  }
  for (const [text, action] of [['まとめる', 'merge'], ['消す', 'delete']]) {
    const b = document.createElement('button');
    b.className = 'tact';
    b.textContent = text;
    b.onclick = () => void run(action);
    bar.appendChild(b);
  }
  const clear = document.createElement('button');
  clear.className = 'tact';
  clear.textContent = 'えらび直す';
  clear.onclick = () => { picked.clear(); onDone(); };
  bar.appendChild(clear);
  host.appendChild(bar);
}

// 自分で片付けるためのボタン。まだ始まっていない依頼は直せる / いつでも消せる
function taskActions(t) {
  const box = document.createElement('div');
  box.className = 'tacts';
  const act = async (action, text) => {
    const r = await post('/task', { action, taskId: t.id, text });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) addSys(d.error ?? 'できなかった');
    boardSoon(50);
  };
  if (t.status === 'queued') {
    const edit = document.createElement('button');
    edit.className = 'tact';
    edit.textContent = '直す';
    edit.onclick = () => {
      const input = document.createElement('input');
      input.value = t.request ?? '';
      input.className = 'tedit';
      input.onkeydown = (e) => {
        if (e.key === 'Escape') return void boardSoon(50);
        if (e.key !== 'Enter' || e.isComposing || !input.value.trim()) return;
        void act('edit', input.value.trim());
      };
      box.replaceChildren(input);
      input.focus();
    };
    box.appendChild(edit);
    const cancel = document.createElement('button');
    cancel.className = 'tact';
    cancel.textContent = 'やめる';
    cancel.onclick = () => void act('cancel');
    box.appendChild(cancel);
  }
  const del = document.createElement('button');
  del.className = 'tact';
  del.textContent = '消す';
  del.onclick = () => void act('delete');
  box.appendChild(del);
  return box;
}

function checkAutoPreview(d) {
  for (const t of d.tasks ?? []) {
    if (!t.id || t.status !== 'done' || (t.artifacts ?? []).length === 0 || previewedTasks.has(t.id)) continue;
    previewedTasks.add(t.id);
    showResultCard(t);
    // 勝手に右を開かない(開くと中央が細くなる = 会話の邪魔)。カードのボタンを押した時だけ開く
  }
}

// 出来たものを「文章と一緒に」会話へ出す(path の羅列で終わらせない)。
// 会話の末尾に足すだけなので何も覆わない = 話している最中でも抑制する必要がない(ルール 2)
function showResultCard(t) {
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'chead';
  head.textContent = '✔ ' + (t.report?.headline || (t.request ?? '').slice(0, 40));
  card.appendChild(head);
  const what = (t.report?.can ?? [])[0];
  if (what) {
    const w = document.createElement('div');
    w.className = 'cwhat';
    w.textContent = what;
    card.appendChild(w);
  }
  const files = document.createElement('div');
  files.className = 'files';
  const touched = [];
  for (const raw of t.artifacts ?? []) {
    const p = cleanPath(raw);
    if (!p) continue;
    if (artifactKind(p) === 'image') card.appendChild(shotOf(p, t.project, () => files.appendChild(fileChip(p, t.project, '🖼 '))));
    else if (artifactKind(p) === 'page') files.appendChild(fileChip(p, t.project, '▶ 開く: '));
    else touched.push(p); // ソースは成果物ではない(さわったもの)
  }
  card.appendChild(files);
  if (touched.length > 0) {
    const w = document.createElement('div');
    w.className = 'cwhat';
    w.textContent = 'さわったもの: ' + touched.join(' / ');
    card.appendChild(w);
  }
  log.appendChild(card);
  lastGroup = null;
  trimLog();
  log.scrollTop = log.scrollHeight;
}
// ---- 進捗をリアルタイムに保つ ----
// ① 部屋の出来事(SSE)が来たら即取り直す ② 作業が動いている間は速く、無い時はゆっくり
// ③ 裏に回ったタブでは止め、戻ってきたら即更新(無駄打ちしない)
let boardTimer = null;
let boardPending = null;
let boardBusy = false;
let boardActive = false;   // renderProgress が「作業中/待機がある」を教えてくれる
function boardSoon(ms = 250) {
  clearTimeout(boardPending);
  boardPending = setTimeout(() => void refreshBoard(), ms);
}
function scheduleBoard() {
  clearTimeout(boardTimer);
  if (document.hidden) return;
  boardTimer = setTimeout(() => void refreshBoard(), boardActive ? 1200 : 5000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshBoard(); });
void refreshBoard();

// ---- W8-7: worker 設定パネル ----
const settingsEl = document.getElementById('settingsBody');
async function renderSettings() {
  const d = await (await post('/settings', {})).json();
  settingsEl.replaceChildren();
  const mk = (labelText, el) => { const l = document.createElement('label'); l.textContent = labelText + ' '; l.appendChild(el); settingsEl.appendChild(l); };
  const modelSel = document.createElement('select');
  for (const m of ['haiku', 'sonnet', 'opus', 'fable']) {
    const o = document.createElement('option'); o.value = m; o.textContent = m; if (d.workerModel === m) o.selected = true; modelSel.appendChild(o);
  }
  modelSel.onchange = () => void post('/settings', { workerModel: modelSel.value });
  mk('作業モデル:', modelSel);
  const effortSel = document.createElement('select');
  for (const e of ['', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const o = document.createElement('option'); o.value = e; o.textContent = e || '既定'; if (d.workerEffort === e) o.selected = true; effortSel.appendChild(o);
  }
  effortSel.onchange = () => void post('/settings', { workerEffort: effortSel.value });
  mk('effort:', effortSel);
  const chatSel = document.createElement('select');
  for (const m of ['haiku', 'sonnet', 'opus', 'fable']) {
    const o = document.createElement('option'); o.value = m; o.textContent = m; if (d.chatModel === m) o.selected = true; chatSel.appendChild(o);
  }
  chatSel.onchange = () => void post('/settings', { chatModel: chatSel.value });
  mk('会話モデル(雑談・返事):', chatSel);
  const chatEffortSel = document.createElement('select');
  for (const e of ['', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const o = document.createElement('option'); o.value = e; o.textContent = e || '既定'; if (d.chatEffort === e) o.selected = true; chatEffortSel.appendChild(o);
  }
  chatEffortSel.onchange = () => void post('/settings', { chatEffort: chatEffortSel.value });
  mk('会話 effort:', chatEffortSel);
  const consult = document.createElement('input');
  consult.type = 'checkbox'; consult.checked = d.consultMode !== false;
  consult.onchange = () => void post('/settings', { consultMode: consult.checked });
  mk('相談してから着手する(すぐ始めない):', consult);
  const commit = document.createElement('input');
  commit.type = 'checkbox'; commit.checked = d.autoCommit !== false;
  commit.onchange = () => void post('/settings', { autoCommit: commit.checked });
  mk('作業が終わったら自動でコミット:', commit);
  const push = document.createElement('input');
  push.type = 'checkbox'; push.checked = !!d.autoPush;
  push.onchange = () => void post('/settings', { autoPush: push.checked });
  mk('そのまま GitHub に push(取り消せないので注意):', push);
  const skills = document.createElement('input');
  skills.type = 'checkbox'; skills.checked = !!d.useUserSettings;
  skills.onchange = () => void post('/settings', { useUserSettings: skills.checked });
  mk('あなたの Claude 設定(skills 等)を使う:', skills);
  const note = document.createElement('div');
  note.className = 'tnote';
  note.textContent = (d.externalMcp ?? []).length > 0
    ? '外部 MCP: ' + d.externalMcp.join(', ')
    : '外部 MCP は ~/.talkingclaw/worker-mcp.json で追加できるよ(次の作業から反映)';
  settingsEl.appendChild(note);
  const proj = document.createElement('div');
  proj.className = 'tnote';
  proj.textContent = '作業先プロジェクト: ' + (d.projects ?? []).join(' / ') + '(追加は ~/.talkingclaw/projects.json。「talkingclaw の◯◯直して」で自己開発)';
  settingsEl.appendChild(proj);
  await renderMemory();
  await renderDict();
}

// 覚えたことを画面から見て消せるようにする。
// 声で覚えるだけで消せないと、間違って覚えたものが残り続ける
async function renderMemory() {
  const box = document.createElement('div');
  box.className = 'editlist';
  const h = document.createElement('b');
  h.textContent = 'クロエが覚えていること';
  box.appendChild(h);
  try {
    const d = await (await post('/memory', {})).json();
    const lines = d.lines ?? [];
    if (lines.length === 0) {
      const e = document.createElement('div');
      e.className = 'tnote';
      e.textContent = 'まだ何も覚えてないよ';
      box.appendChild(e);
    }
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'erow';
      const t = document.createElement('span');
      t.textContent = line.replace(/^-\s*/, '');
      const del = document.createElement('button');
      del.className = 'tact';
      del.textContent = '忘れて';
      del.onclick = async () => { await post('/memory', { remove: line }); void renderSettings(); };
      row.append(t, del);
      box.appendChild(row);
    }
    const add = document.createElement('input');
    add.className = 'tedit';
    add.placeholder = '覚えてほしいことを書いて Enter';
    add.onkeydown = async (e) => {
      if (e.key !== 'Enter' || e.isComposing || !add.value.trim()) return;
      await post('/memory', { add: add.value.trim() });
      void renderSettings();
    };
    box.appendChild(add);
  } catch { /* 次に開いた時に */ }
  settingsEl.appendChild(box);
}

// 聞き間違いの言い換え表。既定ぶんは消せない(もとから入っているもの)
async function renderDict() {
  const box = document.createElement('div');
  box.className = 'editlist';
  const h = document.createElement('b');
  h.textContent = '聞き間違いの言い換え';
  box.appendChild(h);
  try {
    const d = await (await post('/dict', {})).json();
    const all = d.dictionary ?? {};
    const mine = d.user ?? {};
    for (const [wrong, right] of Object.entries(all)) {
      const row = document.createElement('div');
      row.className = 'erow';
      const t = document.createElement('span');
      t.textContent = `${wrong} → ${right}`;
      row.appendChild(t);
      if (wrong in mine) {
        const del = document.createElement('button');
        del.className = 'tact';
        del.textContent = '消す';
        del.onclick = async () => { await post('/dict', { wrong, remove: true }); void renderSettings(); };
        row.appendChild(del);
      } else {
        const note = document.createElement('span');
        note.className = 'tnote';
        note.textContent = 'もとから';
        row.appendChild(note);
      }
      box.appendChild(row);
    }
    const wrongIn = document.createElement('input');
    wrongIn.className = 'tedit';
    wrongIn.placeholder = 'こう聞こえる';
    const rightIn = document.createElement('input');
    rightIn.className = 'tedit';
    rightIn.placeholder = 'ほんとはこれ(Enter で覚える)';
    rightIn.onkeydown = async (e) => {
      if (e.key !== 'Enter' || e.isComposing || !wrongIn.value.trim() || !rightIn.value.trim()) return;
      await post('/dict', { wrong: wrongIn.value.trim(), right: rightIn.value.trim() });
      void renderSettings();
    };
    const row = document.createElement('div');
    row.className = 'erow';
    row.append(wrongIn, rightIn);
    box.appendChild(row);
  } catch { /* 次に開いた時に */ }
  settingsEl.appendChild(box);
}

connect();
void renderSideAlways();          // 常設パネル(部屋・設定)の中身を最初から描いておく
void refreshGame();               // 遊んでいる途中なら、リロードしてもボタンが戻るように
// リロードした時もゲーム部屋なら卓を出す(在室の同期で部屋が分かってから)
setTimeout(() => { if (currentChannel === 'game' && wideLayout()) switchBoardTab('game'); }, 1200);
void showHistory(currentChannel); // リロード直後も直近の会話が見えるように
