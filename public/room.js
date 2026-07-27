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
let handsfree = false;
let listening = false;
let playing = false;
let currentAudio = null; // 6C: barge-in の duck/pause 対象
const audioQueue = [];    // { url, bubble, eventId }
const bubbles = new Map(); // 連続する同一発話者の文を 1 吹き出しにまとめる: key=from
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

function addBubble(cls, text, who) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  if (who) {
    const label = document.createElement('span');
    label.className = 'who';
    label.textContent = who;
    div.appendChild(label);
  }
  const body = document.createElement('span');
  body.textContent = text;
  div.appendChild(body);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return { div, body };
}

function addSys(text) {
  const div = document.createElement('div');
  div.className = 'sys';
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function agentBubble(from, name, text) {
  const prev = bubbles.get('last');
  if (prev && prev.from === from) {
    prev.body.textContent += ' ' + text;
    log.scrollTop = log.scrollHeight;
    return prev;
  }
  const b = addBubble('agent', text, name || from);
  const entry = { from, div: b.div, body: b.body };
  bubbles.set('last', entry);
  return entry;
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
    document.querySelectorAll('.agent.speaking').forEach((el) => el.classList.remove('speaking'));
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

// 相槌の即時再生(queue を経由しない。終了後に通常 queue を再開)
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
  if (ev.type === 'user_speech') {
    if (!isReplay) audioQueue.length = 0; // stale drop: 自分が話したら溜まった読み上げは捨てる(再生中のみ完了させる)
    const b = addBubble('user', ev.text ?? '');
    if (ev.targets && ev.targets.length > 0) {
      const to = document.createElement('span');
      to.className = 'to';
      const names = ev.targets.map((t) => pidNames.get(t) ?? t);
      to.textContent = '→ ' + (ev.targets.length > 2 ? 'みんな' : names.join('・'));
      b.div.appendChild(to);
    }
    bubbles.delete('last');
  } else if (ev.type === 'agent_speech') {
    const b = agentBubble(ev.from, ev.name, ev.text ?? '');
    if (ev.audio && !isReplay) {
      // S6: 相槌(ack)は FIFO に入れない独立即時スロット — 再生中なら即スキップ
      if (ev.filler === 'ack') { if (!playing) playAckNow(ev.audio, b.div, ev.id, ev.text); }
      else enqueueAudio(ev.audio, b.div, ev.id, ev.turnId, ev.filler, ev.text);
      // 6B: 本応答が来たら同 turn の未再生 filler を破棄(キャンセル 3 層目)
      if (!ev.filler && ev.turnId) {
        for (let i = audioQueue.length - 1; i >= 0; i--) {
          if (audioQueue[i].filler && audioQueue[i].turnId === ev.turnId) audioQueue.splice(i, 1);
        }
      }
    }
  } else if (ev.type === 'system' || ev.type === 'presence') {
    addSys((ev.name ? ev.name + ': ' : '') + (ev.text ?? ev.type));
    bubbles.delete('last');
    if (ev.type === 'presence' && typeof refreshRoster === 'function') setTimeout(() => refreshRoster(), 100);
  }
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
  setStatus('届けたよ');
  try {
    const res = await post('/chat', { text });
    if (res.status === 401) return void checkRestart();
    if (!res.ok) addSys('送信エラー: ' + res.status);
  } catch { addSys('サーバに繋がらないみたい'); }
}
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { void send(textInput.value); textInput.value = ''; }
});

// ---- 音声認識 + STT 計測(S10 gate ①: speechend→final Δt)----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let interimEl = null;
let speechEndAt = 0;
let interimUpdatedAt = 0; // interim ゲート(S6): 本応答の再生開始を保留(ack は対象外)
let interimStartedAt = 0;
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
      if (!interimEl) { interimEl = document.createElement('div'); interimEl.className = 'interim'; }
      interimEl.textContent = interim + '…';
      log.appendChild(interimEl);
      log.scrollTop = log.scrollHeight;
    }
    if (finalText) {
      sttFails = 0;
      interimUpdatedAt = 0; // final で即クリア(S6)
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
          currentAudio.pause();           // 再生中 = pause(S11)
          audioQueue.length = 0;          // 未再生 = 破棄
          playing = false;
          document.querySelectorAll('.agent.speaking').forEach((el) => el.classList.remove('speaking'));
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
let selectedPid = null;
const pidNames = new Map();
async function refreshRoster() {
  try {
    const r = await fetch('/participants?token=' + TOKEN);
    const d = await r.json();
    selectedPid = d.selected;
    rosterEl.replaceChildren();
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
      const chip = document.createElement('span');
      chip.className = 'chip ' + (p.presence === 'gone' ? 'gone' : 'active') + (p.participantId === selectedPid ? ' selected' : '');
      chip.textContent = p.name + (p.voice !== 'ready' ? '(声なし)' : '');
      chip.onclick = async () => {
        const next = selectedPid === p.participantId ? null : p.participantId;
        await post('/select', { participantId: next });
        void refreshRoster();
      };
      rosterEl.appendChild(chip);
    }
  } catch { /* 次の更新で */ }
}
setInterval(refreshRoster, 5000);
void refreshRoster();

// ---- W8-3: 作業ボード(誰が何をどこまで)----
const boardEl = document.getElementById('board');
let boardOpen = false;
document.getElementById('boardBtn').onclick = () => {
  boardOpen = !boardOpen;
  boardEl.style.display = boardOpen ? 'block' : 'none';
  if (boardOpen) void refreshBoard();
};
document.getElementById('logBtn').onclick = () => window.open('/transcript.md?token=' + TOKEN);
async function refreshBoard() {
  if (!boardOpen) return;
  try {
    const r = await post('/tasks', {});
    const d = await r.json();
    boardEl.replaceChildren();
    const rows = [...(d.tasks ?? []), ...(d.open ?? [])];
    if (rows.length === 0) {
      const e = document.createElement('div'); e.className = 'tnote'; e.textContent = 'いまは作業なし'; boardEl.appendChild(e);
    }
    for (const t of rows) {
      const div = document.createElement('div');
      div.className = 'task';
      const stat = document.createElement('span');
      stat.className = 'tstat ' + t.status;
      stat.textContent = { queued: '待機', working: '⚙ 作業中', done: '✔ 完了', failed: '✖ 失敗' }[t.status] ?? t.status;
      div.appendChild(stat);
      const req = document.createElement('span');
      req.textContent = `${t.agentName}: ${(t.request ?? '').slice(0, 60)}`;
      div.appendChild(req);
      if (t.notes && t.notes.length > 0) {
        const note = document.createElement('span');
        note.className = 'tnote';
        note.textContent = '実況: ' + t.notes[t.notes.length - 1];
        div.appendChild(note);
      }
      for (const a of t.artifacts ?? []) {
        const link = document.createElement('a');
        link.href = '/files/' + encodeURIComponent(a).replace(/%2F/g, '/') + '?token=' + TOKEN;
        link.target = '_blank';
        link.textContent = ' 📦 ' + a;
        div.appendChild(link);
      }
      boardEl.appendChild(div);
    }
  } catch { /* 次回 */ }
}
setInterval(refreshBoard, 5000);

connect();
