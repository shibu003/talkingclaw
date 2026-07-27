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
const audioQueue = [];    // { url, bubble, eventId }
const bubbles = new Map(); // 連続する同一発話者の文を 1 吹き出しにまとめる: key=from

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
    resumeMic();
    return;
  }
  playing = true;
  pauseMic();
  next.bubble.classList.add('speaking');
  const audio = new Audio(next.url + '?token=' + TOKEN); // S1: token 付与はブラウザ側
  let advanced = false;
  const advance = () => {
    if (advanced) return;
    advanced = true;
    next.bubble.classList.remove('speaking');
    if (next.eventId) void post('/played', { eventId: next.eventId }); // S10/S4 計測・floor 用
    playNext();
  };
  audio.onended = audio.onerror = advance;
  audio.play().catch(advance);
}

function enqueueAudio(url, bubble, eventId) {
  audioQueue.push({ url, bubble, eventId });
  if (!playing) playNext();
}

// 相槌の即時再生(queue を経由しない。終了後に通常 queue を再開)
function playAckNow(url, bubble, eventId) {
  playing = true;
  pauseMic(); // マイク方針は SP3 の実測で確定(現状は保守的に停止)
  bubble.classList.add('speaking');
  const audio = new Audio(url + '?token=' + TOKEN);
  let advanced = false;
  const advance = () => {
    if (advanced) return;
    advanced = true;
    bubble.classList.remove('speaking');
    if (eventId) void post('/played', { eventId });
    playNext(); // 通常 queue の続きへ(空なら resumeMic される)
  };
  audio.onended = audio.onerror = advance;
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
    addBubble('user', ev.text ?? '');
    bubbles.delete('last');
  } else if (ev.type === 'agent_speech') {
    const b = agentBubble(ev.from, ev.name, ev.text ?? '');
    if (ev.audio && !isReplay) {
      // S6: 相槌(ack)は FIFO に入れない独立即時スロット — 再生中なら即スキップ
      if (ev.filler === 'ack') { if (!playing) playAckNow(ev.audio, b.div, ev.id); }
      else enqueueAudio(ev.audio, b.div, ev.id);
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
  recognition.onend = () => {
    listening = false;
    interimUpdatedAt = 0;
    micBtn.classList.remove('listening');
    interimEl?.remove(); interimEl = null;
    if (handsfree && !playing) setTimeout(() => { if (handsfree && !playing && !listening) startMic(); }, 300);
  };
  recognition.onerror = (e) => {
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
      interimUpdatedAt = 0; // final で即クリア(S6)
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

micBtn.addEventListener('click', () => {
  handsfree = !handsfree;
  micBtn.classList.toggle('on', handsfree);
  if (handsfree) startMic();
  else { pauseMic(); setStatus('🎤 でハンズフリー開始'); }
});

// ---- 在室リスト + 相手選択(4A-2)----
const rosterEl = document.getElementById('roster');
let selectedPid = null;
async function refreshRoster() {
  try {
    const r = await fetch('/participants?token=' + TOKEN);
    const d = await r.json();
    selectedPid = d.selected;
    rosterEl.replaceChildren();
    for (const p of d.participants) {
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

connect();
