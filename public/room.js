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
    // 短い相槌(「うん」等)では溜まった読み上げを捨てない。長い発話 = 話題転換とみなして捨てる
    if (!isReplay && (ev.text ?? '').length >= 8) audioQueue.length = 0;
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
      if (ev.filler === 'ack') maybePlayAck(ev.audio, b.div, ev.id, ev.text);
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
  // 部屋で何か起きた = 作業の状態も変わっている可能性。進捗表示をすぐ取り直す
  boardSoon();
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
    const res = await post('/chat', { text });
    if (res.status === 401) return void checkRestart();
    if (!res.ok) addSys('送信エラー: ' + res.status);
  } catch { addSys('サーバに繋がらないみたい'); }
}
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
    if (d.channel && d.channel !== currentChannel) { currentChannel = d.channel; updateRoomBtn(); }
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

// ---- W8-7: 成果物プレビュー(その場で見る)----
const previewEl = document.getElementById('preview');
const previewFrame = document.getElementById('previewFrame');
const previewTitle = document.getElementById('previewTitle');
const previewOpen = document.getElementById('previewOpen');
document.getElementById('previewClose').onclick = () => { previewEl.classList.remove('open'); previewFrame.src = 'about:blank'; };
function showPreview(relPath) {
  void post('/ui-state', { preview: relPath, board: boardOpen }); // W10-2: クロエが画面を把握できるように
  const url = '/files/' + encodeURIComponent(relPath).replace(/%2F/g, '/') + '?token=' + TOKEN;
  previewTitle.textContent = relPath;
  previewOpen.href = url;
  previewFrame.src = url;
  previewEl.classList.add('open');
}
const previewedTasks = new Set();

// ---- パネル(部屋 / 作業ボード / 設定)。開くのは同時に 1 枚だけ ----
const boardEl = document.getElementById('boardList');
let boardOpen = false;
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
  boardOpen = openedPanel === 'board';
  if (openedPanel) void panels[openedPanel].render();
}
for (const [key, p] of Object.entries(panels)) p.btn.onclick = () => openPanel(key);

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
async function renderRooms() {
  await fetchRooms();
  updateRoomBtn();
  const list = document.getElementById('roomList');
  list.replaceChildren();
  for (const room of roomList) {
    const btn = document.createElement('button');
    btn.className = 'room' + (room.channel === currentChannel ? ' here' : '');
    btn.textContent = room.label;
    if (room.channel === currentChannel) {
      const mark = document.createElement('span');
      mark.className = 'here-mark';
      mark.textContent = 'いまここ';
      btn.appendChild(mark);
    }
    btn.onclick = () => void enterRoom(room.channel);
    list.appendChild(btn);
  }
}
async function enterRoom(next) {
  openPanel(null);
  if (next === currentChannel) return;
  await post('/channel', { channel: next });
  currentChannel = next;
  updateRoomBtn();
  log.replaceChildren();
  bubbles.clear();
  audioQueue.length = 0;
  await showHistory(next); // 切り替えた部屋の直近の会話を読み込む(白紙にしない)
}

// 部屋に入った時、その部屋で話していた内容を読み直す(音は鳴らさない)
async function showHistory(channel, lines = 40) {
  try {
    const d = await (await post('/transcript', { channel, lines })).json();
    const rows = d.lines ?? [];
    if (rows.length === 0) { addSys('この部屋はまだ会話がないよ'); return; }
    addSys(`— ここまでが ${roomLabel(channel)} の直近の会話 —`);
    for (const r of rows) {
      if (r.who === 'あなた') addBubble('user', r.text);
      else agentBubble('history:' + r.who, r.who, r.text);
    }
    bubbles.delete('last'); // 履歴とライブの吹き出しをつなげない
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
    showPanelForce(intent.kind);
    addSys({ rooms: '部屋の一覧を出したよ', board: '作業ボードを出したよ', settings: '設定を出したよ' }[intent.kind]);
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
    showPreview(last.artifacts[last.artifacts.length - 1]);
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
progressEl.onclick = () => showPanelForce('board');
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

async function refreshBoard() {
  if (boardBusy) return; // 取得が重ならないように(SSE 連打 + 定期更新)
  boardBusy = true;
  try {
    const r = await post('/tasks', {});
    const d = await r.json();
    const rows = [...(d.tasks ?? []), ...(d.open ?? [])];
    renderProgress(rows);          // 帯はボードを開いていなくても常に最新に
    renderPlan(d.plan ?? null);    // 相談中の案(あれば)
    checkAutoPreview(d);           // 完成した成果物はその場で開く
    if (!boardOpen) return;
    boardEl.replaceChildren();
    if (rows.length === 0) {
      const e = document.createElement('div'); e.className = 'tnote'; e.textContent = 'いまは作業なし'; boardEl.appendChild(e);
    }
    for (const t of rows) {
      const div = document.createElement('div');
      div.className = 'task';
      const stat = document.createElement('span');
      stat.className = 'tstat ' + t.status;
      stat.textContent = STAT_LABEL[t.status] ?? t.status;
      div.appendChild(stat);
      const req = document.createElement('span');
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
      for (const a of t.artifacts ?? []) {
        const link = document.createElement('a');
        link.href = '#';
        link.textContent = ' 📦 ' + a;
        link.onclick = (e) => { e.preventDefault(); showPreview(a); };
        div.appendChild(link);
      }
      boardEl.appendChild(div);
    }
  } catch { /* 次回 */ } finally {
    boardBusy = false;
    scheduleBoard(); // 次の更新を状況に合わせて予約(作業中は速く)
  }
}
function checkAutoPreview(d) {
  for (const t of d.tasks ?? []) {
    if (t.id && t.status === 'done' && (t.artifacts ?? []).length > 0 && !previewedTasks.has(t.id)) {
      previewedTasks.add(t.id);
      showPreview(t.artifacts[0]);
    }
  }
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
}

connect();
void showHistory(currentChannel); // リロード直後も直近の会話が見えるように
