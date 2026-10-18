'use strict';
(() => {
  const $ = s => document.querySelector(s);
  const canvas = $('#worldCanvas');
  const ctx = canvas.getContext('2d');
  const modalRoot = $('#modalRoot');
  const speechLayer = $('#speechLayer') || canvas.insertAdjacentElement('afterend', Object.assign(document.createElement('div'), { id: 'speechLayer', className: 'speech-layer' }));
  speechLayer.setAttribute('aria-hidden', 'true');
  const state = {
    characters: [], locations: [], players: [], online: 0, mapId: 'map-006', map: null,
    currentId: null, name: 'Гость', characterId: 'madley', socket: null, reconnectTimer: null,
    profile: loadProfile(), started: false, soundOn: true, audio: null, musicTimer: null, musicStep: 0,
    keys: new Set(), input: { x: 0, y: 0 }, lastMoveSent: 0, chatCollapsed: false,
    incoming: null, duel: null, dodge: null, chatCounts: {}, recentChats: [], speechBubbles: new Map(),
    heart: { x: .5, y: .72 }, dodgeHits: new Set(), dodgeScoreSent: false,
    lastFrame: performance.now(), lastProfileSave: 0, mobilePointer: null
  };
  const images = new Map();
  const achievements = [
    { id: 'first-step', icon: '⌖', title: 'Первый шаг', text: 'Посети свою первую локацию.', type: 'explored', value: 1 },
    { id: 'wanderer', icon: '✦', title: 'Путешественник', text: 'Исследуй 5 разных локаций.', type: 'explored', value: 5 },
    { id: 'cartographer', icon: '◎', title: 'Знающий мир', text: 'Побывай в 10 локациях.', type: 'explored', value: 10 },
    { id: 'first-duel', icon: '⚔', title: 'Первая дуэль', text: 'Сыграй свой первый бой.', type: 'battles', value: 1 },
    { id: 'veteran', icon: '♜', title: 'Ветеран арены', text: 'Заверши 5 дуэлей.', type: 'battles', value: 5 },
    { id: 'first-win', icon: '♛', title: 'Первая победа', text: 'Выиграй дуэль.', type: 'wins', value: 1 },
    { id: 'champion', icon: '✹', title: 'Чемпион', text: 'Выиграй 5 дуэлей.', type: 'wins', value: 5 },
    { id: 'hello', icon: '☻', title: 'На связи', text: 'Отправь сообщение в общий чат.', type: 'messages', value: 1 },
    { id: 'storyteller', icon: '✎', title: 'Слово за слово', text: 'Отправь 20 сообщений.', type: 'messages', value: 20 }
  ];

  function loadProfile() {
    try {
      const data = JSON.parse(localStorage.getItem('githProfile') || '{}');
      return { wins: Math.max(0, data.wins | 0), battles: Math.max(0, data.battles | 0), messages: Math.max(0, data.messages | 0),
        explored: Array.isArray(data.explored) ? data.explored.filter(x => typeof x === 'string') : [] };
    } catch { return { wins: 0, battles: 0, messages: 0, explored: [] }; }
  }
  function saveProfile() {
    localStorage.setItem('githProfile', JSON.stringify(state.profile));
    if (Date.now() - state.lastProfileSave > 5000) { state.lastProfileSave = Date.now(); renderRosterIfOpen(); }
  }
  function unlockValue(type) {
    if (type === 'explored') return state.profile.explored.length;
    return state.profile[type] || 0;
  }
  function isUnlocked(char) { return char.unlock?.type === 'starter' || unlockValue(char.unlock?.type) >= (char.unlock?.value || 1); }
  function unlockLabel(char) {
    const need = char.unlock?.value || 1;
    const have = unlockValue(char.unlock?.type);
    const type = char.unlock?.type;
    const words = { wins: 'побед', battles: 'дуэлей', messages: 'сообщений', explored: 'локаций' };
    return `${Math.min(have, need)}/${need} ${words[type] || ''}`;
  }
  function send(type, data = {}) {
    if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type, ...data }));
  }
  function setConnection(status, label) {
    const el = $('#connectionBadge'); el.className = 'connection-badge' + (status ? ` ${status}` : '');
    el.querySelector('span').textContent = label;
    if (status === 'connected') setTimeout(() => el.classList.add('hidden'), 2200);
    else el.classList.remove('hidden');
  }
  function toast(text, tone = '') {
    const el = document.createElement('div'); el.className = `toast ${tone}`; el.textContent = text;
    $('#toastStack').append(el); setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(-7px)'; setTimeout(() => el.remove(), 240); }, 3000);
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function getChar(id) { return state.characters.find(c => c.id === id) || state.characters[0]; }
  function getLocation(id) { return state.locations.find(l => l.id === id) || state.locations[0]; }
  function getMapImage(loc) {
    if (!loc) return null;
    if (!images.has(loc.id)) { const im = new Image(); im.src = loc.image; im.onload = () => {}; images.set(loc.id, im); }
    return images.get(loc.id);
  }
  async function init() {
    const [characters, locations] = await Promise.all([
      fetch('/characters.json').then(r => r.json()), fetch('/locations.json').then(r => r.json())
    ]);
    state.characters = characters; state.locations = locations;
    const savedChar = localStorage.getItem('githCharacter');
    if (characters.some(c => c.id === savedChar) && isUnlocked(characters.find(c => c.id === savedChar))) state.characterId = savedChar;
    const savedMap = localStorage.getItem('githMap');
    if (locations.some(l => l.id === savedMap)) state.mapId = savedMap;
    state.name = localStorage.getItem('githName') || 'Гость';
    markExplored(state.mapId);
    updateTopBar();
    setupInputs();
    resize(); requestAnimationFrame(frame);
    if (localStorage.getItem('githStarted') === 'yes') {
      state.started = true; joinWorld();
    } else { $('#connectionBadge').classList.add('hidden'); showStartScreen(); }
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  }

  function updateTopBar() {
    const loc = getLocation(state.mapId), char = getChar(state.characterId);
    $('#locationName').textContent = loc?.name || 'Неизвестная локация';
    $('#chatLocation').textContent = loc?.name || '—';
    $('#myName').textContent = state.name || 'Гость';
    $('#myCharacter').textContent = char?.name || 'Мэдли Кэррот';
    $('#myAvatar').src = char?.image || '/assets/characters/madley.png';
    $('#onlineCount').textContent = String(state.online || (state.started ? 1 : 0));
  }
  function markExplored(id) {
    if (id && !state.profile.explored.includes(id)) { state.profile.explored.push(id); saveProfile(); }
  }
  function joinWorld() {
    const loc = getLocation(state.mapId);
    state.map = loc; getMapImage(loc); updateTopBar(); startMusic(); connect();
  }
  function connect() {
    if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`); state.socket = ws;
    setConnection('', 'Подключение к миру…');
    ws.addEventListener('open', () => {
      setConnection('connected', 'На связи');
      send('join', { name: state.name, characterId: state.characterId, mapId: state.mapId });
    });
    ws.addEventListener('message', ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } handleMessage(m); });
    ws.addEventListener('close', () => {
      state.currentId = null; clearSpeechBubbles();
      if (state.started) { setConnection('disconnected', 'Связь потеряна · переподключаемся'); clearTimeout(state.reconnectTimer); state.reconnectTimer = setTimeout(connect, 1800); }
    });
    ws.addEventListener('error', () => setConnection('disconnected', 'Нет соединения с сервером'));
  }
  function handleMessage(m) {
    if (m.type === 'joined') {
      state.currentId = m.id; state.online = m.online || 1; state.players = [m.player]; updateTopBar(); renderPlayers(); send('move', state.input);
    } else if (m.type === 'world') {
      state.players = m.players || []; state.online = m.online || state.players.length; updateTopBar(); renderPlayers();
    } else if (m.type === 'chat') addChat(m);
    else if (m.type === 'notice') toast(m.text || '');
    else if (m.type === 'travelled') {
      state.mapId = m.mapId; state.map = getLocation(m.mapId); getMapImage(state.map); markExplored(m.mapId);
      localStorage.setItem('githMap', m.mapId); clearChat(); updateTopBar(); startMusic(); toast(`Локация: ${state.map.name}`, 'success');
    } else if (m.type === 'challengeIncoming') {
      state.incoming = m; const ch = getChar(m.from.characterId); $('#challengeAvatar').src = ch?.image || '/assets/characters/madley.png';
      $('#challengeText').textContent = `${m.from.name} вызывает на дуэль`;
      $('#incomingChallenge').classList.remove('hidden');
    } else if (m.type === 'challengeSent') toast(`Вызов отправлен игроку ${m.target.name}`);
    else if (m.type === 'challengeExpired') { if (state.incoming?.challengeId === m.challengeId) state.incoming = null; $('#incomingChallenge').classList.add('hidden'); toast('Вызов истёк.'); }
    else if (m.type === 'challengeDeclined') toast(`${m.name} отказался от дуэли.`);
    else if (m.type === 'duelStart') beginDuel(m);
    else if (m.type === 'duelTurn') updateDuelTurn(m);
    else if (m.type === 'dodgeStart') beginDodge(m);
    else if (m.type === 'duelResult') showDuelResult(m);
    else if (m.type === 'duelEnd') finishDuel(m);
  }
  function addChat(m) {
    const line = document.createElement('div'); line.className = `chat-line${m.playerId === state.currentId ? ' mine' : ''}`;
    const name = document.createElement('b'); name.textContent = m.name;
    const text = document.createElement('span'); text.textContent = m.text;
    const time = document.createElement('small'); time.className = 'chat-time';
    time.textContent = new Date(m.time || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    line.append(name, text, time); $('#chatMessages').append(line);
    $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
    if (m.playerId === state.currentId) { state.profile.messages++; saveProfile(); }
    state.recentChats.push(m); if (state.recentChats.length > 80) state.recentChats.shift();
    showSpeechBubble(m);
  }
  function clearChat() {
    $('#chatMessages').replaceChildren(); state.recentChats = []; clearSpeechBubbles();
    const note = document.createElement('div'); note.className = 'system-message'; note.textContent = `Ты прибыл в «${state.map?.name || ''}». Поздоровайся с местными!`;
    $('#chatMessages').append(note);
  }
  function showSpeechBubble(message) {
    const text = String(message.text || '').trim().slice(0, 180);
    if (!text || !state.players.some(p => p.id === message.playerId)) return;
    const previous = state.speechBubbles.get(message.playerId);
    if (previous) previous.el.remove();
    const el = document.createElement('div');
    el.className = 'speech-bubble' + (message.playerId === state.currentId ? ' mine' : '');
    el.dataset.playerId = message.playerId;
    el.textContent = text; // Messages are plain text, never player-supplied HTML.
    speechLayer.append(el);
    const now = performance.now();
    state.speechBubbles.set(message.playerId, {
      el, mapId: state.mapId, expiresAt: now + Math.max(4500, Math.min(12000, 2800 + Array.from(text).length * 45))
    });
  }
  function clearSpeechBubbles() {
    speechLayer.replaceChildren(); state.speechBubbles.clear();
  }
  function updateSpeechBubbles(w, h, now) {
    if (!state.speechBubbles.size) return;
    const players = new Map(state.players.map(p => [p.id, p]));
    const active = [];
    for (const [id, bubble] of state.speechBubbles) {
      if (now >= bubble.expiresAt || bubble.mapId !== state.mapId || !players.has(id)) {
        bubble.el.remove(); state.speechBubbles.delete(id); continue;
      }
      active.push({ id, bubble, anchor: playerLayout(players.get(id), w, h, now), width: bubble.el.offsetWidth, height: bubble.el.offsetHeight });
    }
    // Keep your own message closest to its speaker; nearby messages stack rather than overlap.
    active.sort((a, b) => Number(b.id === state.currentId) - Number(a.id === state.currentId) || a.anchor.baseY - b.anchor.baseY);
    const placed = [], gap = 10;
    for (const { bubble, anchor, width, height } of active) {
      const left = Math.max(12, Math.min(w - width - 12, anchor.x - width / 2));
      const maxY = Math.max(12, h - 78 - height), minY = Math.min(w <= 680 ? 78 : 98, maxY);
      const clampY = y => Math.max(minY, Math.min(maxY, y));
      const above = anchor.nameY - height - 12, below = anchor.baseY + 22 * anchor.scale;
      const preferred = above >= minY ? above : below;
      const candidates = [clampY(preferred), clampY(below), ...placed.flatMap(r => [clampY(r.y - height - gap), clampY(r.y + r.height + gap)])];
      const overlaps = y => placed.reduce((area, r) => {
        const dx = Math.max(0, Math.min(left + width + gap, r.x + r.width) - Math.max(left - gap, r.x));
        const dy = Math.max(0, Math.min(y + height + gap, r.y + r.height) - Math.max(y - gap, r.y));
        return area + dx * dy;
      }, 0);
      candidates.sort((a, b) => overlaps(a) - overlaps(b) || Math.abs(a - preferred) - Math.abs(b - preferred));
      const top = candidates[0];
      placed.push({ x: left, y: top, width, height });
      bubble.el.style.transform = `translate3d(${left.toFixed(1)}px,${top.toFixed(1)}px,0)`;
      bubble.el.style.setProperty('--tail-x', `${Math.max(17, Math.min(width - 17, anchor.x - left))}px`);
      bubble.el.classList.toggle('below', top > anchor.nameY);
      bubble.el.classList.toggle('is-leaving', bubble.expiresAt - now < 450);
    }
  }
  function renderPlayers() {
    const list = $('#playersList'); if (!list) return;
    const others = state.players.filter(p => p.id !== state.currentId);
    $('#nearCount').textContent = String(others.length);
    list.replaceChildren();
    if (!state.started) { list.innerHTML = '<div class="empty-note">Здесь появятся другие игроки, когда подключишься.</div>'; return; }
    const sorted = [...state.players].sort((a,b) => (a.id === state.currentId ? -1 : b.id === state.currentId ? 1 : a.name.localeCompare(b.name, 'ru')));
    for (const p of sorted) {
      const char = getChar(p.characterId); const row = document.createElement('button');
      row.className = 'player-row'; row.type = 'button';
      const img = document.createElement('img'); img.src = char?.image || '/assets/characters/madley.png'; img.alt = '';
      const copy = document.createElement('span'); copy.className = 'player-copy';
      const nm = document.createElement('b'); nm.textContent = p.id === state.currentId ? `${p.name} · ты` : p.name;
      const role = document.createElement('small'); role.textContent = char?.name || 'Странник';
      copy.append(nm, role); const dot = document.createElement('i'); dot.className = 'player-dot'; row.append(img, copy, dot);
      if (p.id === state.currentId) { row.disabled = true; row.style.opacity = '.78'; }
      else row.addEventListener('click', () => challenge(p.id));
      list.append(row);
    }
    if (!state.players.length) list.innerHTML = '<div class="empty-note">Загружаем обитателей…</div>';
  }
  function challenge(id) {
    const p = state.players.find(x => x.id === id); if (!p) return toast('Игрок уже ушёл.');
    send('challenge', { targetId: id });
  }
  function renderRosterHTML(context = 'switch') {
    const cards = state.characters.map(c => {
      const unlocked = isUnlocked(c); const selected = c.id === state.characterId;
      return `<button type="button" class="character-card ${unlocked ? '' : 'locked'} ${selected ? 'selected' : ''}" data-char="${esc(c.id)}" ${unlocked ? '' : 'disabled'}>
        ${unlocked ? '' : `<span class="lock-ribbon">🔒 ${esc(unlockLabel(c))}</span>`}
        <img src="${esc(c.image)}" alt=""><b>${esc(c.name)}</b><small>${esc(c.role)}</small><small class="card-attack">✦ ${esc(c.attack)}</small>
      </button>`;
    }).join('');
    return `<div class="character-grid">${cards}</div>`;
  }
  function attachCharacterCards(container) {
    container.querySelectorAll('[data-char]').forEach(card => card.addEventListener('click', () => {
      const c = getChar(card.dataset.char); if (!c || !isUnlocked(c)) return;
      state.characterId = c.id; localStorage.setItem('githCharacter', c.id); updateTopBar();
      if (state.started) send('character', { characterId: c.id });
      container.querySelectorAll('[data-char]').forEach(el => el.classList.toggle('selected', el.dataset.char === c.id));
      const badge = $('#startSelectedName'); if (badge) badge.textContent = c.name;
    }));
  }
  function showStartScreen() {
    modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal-card start-card">
      <div class="modal-head"><div><span class="eyebrow">ТВОЯ ИСТОРИЯ НАЧИНАЕТСЯ ЗДЕСЬ</span><h1>Добро пожаловать в Gith World</h1><p>Исследуй 95 локаций, знакомься с игроками, открывай персонажей за достижения и вызывай соперников на bullet-hell дуэли.</p></div></div>
      <div class="modal-content"><div class="start-layout"><label class="name-field"><span>Имя персонажа</span><input id="startName" maxlength="22" autocomplete="nickname" value="${esc(state.name === 'Гость' ? '' : state.name)}" placeholder="Например, Алекс"></label>
        <p class="start-subtitle">Выбери стартового героя <b id="startSelectedName">${esc(getChar(state.characterId)?.name || 'Мэдли Кэррот')}</b>. Остальные открываются за ачивки.</p>${renderRosterHTML('start')}</div></div>
      <div class="modal-footer"><div class="start-foot"><label class="music-switch"><input id="startMusic" type="checkbox" checked> Музыка локаций</label><span>WASD / стрелки — ходить · F — вызвать на бой</span></div><button class="primary-btn" id="startButton">Войти в мир →</button></div>
      </section></div>`;
    const cards = modalRoot.querySelector('.character-grid'); attachCharacterCards(cards);
    $('#startButton').addEventListener('click', () => {
      state.name = $('#startName').value.trim().slice(0,22) || 'Гость';
      localStorage.setItem('githName', state.name); localStorage.setItem('githStarted','yes'); state.started = true;
      state.soundOn = $('#startMusic').checked; setSoundButton(); modalRoot.replaceChildren(); joinWorld(); toast('Добро пожаловать! Исследуй мир ✨', 'success');
    });
    $('#startName').addEventListener('keydown', e => { if (e.key === 'Enter') $('#startButton').click(); });
  }
  function openCharacters() {
    modalRoot.innerHTML = `<div class="modal-backdrop" data-close><section class="modal-card" role="dialog" aria-modal="true">
      <div class="modal-head"><div><span class="eyebrow">ГЕРОИ И СПОСОБНОСТИ</span><h1>Коллекция персонажей</h1><p>У каждого бойца своя уникальная атака. Победы, дуэли, сообщения и новые локации открывают героев.</p></div><button class="modal-close" data-x>×</button></div>
      <div class="modal-content">${renderRosterHTML()}</div><div class="modal-footer"><span class="condition-note">Открыто: <b>${state.characters.filter(isUnlocked).length}</b> / ${state.characters.length}</span><button class="subtle-btn" data-x>Готово</button></div></section></div>`;
    const grid = modalRoot.querySelector('.character-grid'); attachCharacterCards(grid);
    modalRoot.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);
    modalRoot.querySelector('[data-close]').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  }
  function renderRosterIfOpen() {
    const grid = modalRoot.querySelector('.character-grid');
    if (grid && modalRoot.querySelector('.modal-card:not(.start-card)')) openCharacters();
  }
  function closeModal() { modalRoot.replaceChildren(); }
  function showMaps() {
    const cards = state.locations.map(loc => `<button class="map-card ${loc.id === state.mapId ? 'active' : ''}" data-map="${esc(loc.id)}" data-name="${esc(loc.name.toLowerCase())}"><img loading="lazy" src="${esc(loc.image)}" alt=""><em>${moodLabel(loc.mood)}</em><span>${esc(loc.name)}</span></button>`).join('');
    modalRoot.innerHTML = `<div class="modal-backdrop" data-close><section class="modal-card"><div class="modal-head"><div><span class="eyebrow">95 МИРОВ · У КАЖДОГО СВОЙ САУНДТРЕК</span><h1>Куда отправимся?</h1><p>Фоны извлечены из твоего архива локаций. При переходе меняются и музыка, и чат.</p></div><button class="modal-close" data-x>×</button></div><div class="modal-content"><input id="mapSearch" class="map-search" placeholder="Найти локацию…"> <div class="map-grid">${cards}</div></div><div class="modal-footer"><span class="condition-note">Исследовано: <b>${state.profile.explored.length}</b> / ${state.locations.length}</span><button class="subtle-btn" data-x>Закрыть</button></div></section></div>`;
    modalRoot.querySelectorAll('[data-map]').forEach(card => card.addEventListener('click', () => {
      const id = card.dataset.map; if (id === state.mapId) { closeModal(); return; }
      state.mapId = id; state.map = getLocation(id); getMapImage(state.map); markExplored(id); localStorage.setItem('githMap', id); updateTopBar(); startMusic(); clearChat();
      if (state.started) send('travel', { mapId: id }); closeModal(); toast(`Путешествие: ${state.map.name}`, 'success');
    }));
    $('#mapSearch').addEventListener('input', e => {
      const q = e.target.value.toLowerCase().trim(); modalRoot.querySelectorAll('.map-card').forEach(c => c.hidden = !c.dataset.name.includes(q));
    });
    modalRoot.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);
    modalRoot.querySelector('[data-close]').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  }
  function moodLabel(mood) { return ({dark:'ТЬМА',dream:'СНЫ',town:'ГОРОД',chill:'ТИШИНА',arcade:'МИР'})[mood] || 'МИР'; }
  function showAchievements() {
    const cards = achievements.map(a => {
      const value = unlockValue(a.type), done = value >= a.value, pct = Math.min(100, value / a.value * 100);
      return `<div class="achievement-card ${done ? 'done' : ''}"><span class="achievement-icon">${a.icon}</span><div><b>${esc(a.title)} ${done ? '✓' : ''}</b><small>${esc(a.text)}</small>${done ? '' : `<div class="progress-line"><span style="width:${pct}%"></span></div>`}</div></div>`;
    }).join('');
    modalRoot.innerHTML = `<div class="modal-backdrop" data-close><section class="modal-card compact"><div class="modal-head"><div><span class="eyebrow">ПРОГРЕСС · ЛОКАЛЬНО СОХРАНЯЕТСЯ</span><h1>Достижения</h1><p>Каждый шаг приближает к новым бойцам.</p></div><button class="modal-close" data-x>×</button></div><div class="modal-content"><div class="achievement-list">${cards}</div></div><div class="modal-footer"><span class="condition-note">Дуэлей: <b>${state.profile.battles}</b> · побед: <b>${state.profile.wins}</b></span><button class="subtle-btn" data-x>Готово</button></div></section></div>`;
    modalRoot.querySelectorAll('[data-x]').forEach(b => b.onclick = closeModal);
    modalRoot.querySelector('[data-close]').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
  }
  function startTravel(id) {
    state.mapId = id; state.map = getLocation(id); getMapImage(state.map); markExplored(id); localStorage.setItem('githMap', id); updateTopBar(); startMusic(); clearChat(); send('travel', { mapId: id });
  }

  function beginDuel(m) {
    state.incoming = null; $('#incomingChallenge').classList.add('hidden');
    state.duel = { id: m.duelId, a: m.a, b: m.b, hp: m.hp || {}, round: m.round || 1, turn: m.turn, players: m.players || {}, phase: m.phase };
    $('#battlePanel').classList.remove('hidden'); updateDuelNames(); updateDuelHealth(); updateDuelTurn(m);
    toast('Дуэль началась! Удачи на арене.', 'success');
  }
  function updateDuelNames() {
    if (!state.duel) return;
    const pA = state.duel.players[state.duel.a] || state.players.find(p => p.id === state.duel.a) || { name: 'Игрок', characterId: 'madley' };
    const pB = state.duel.players[state.duel.b] || state.players.find(p => p.id === state.duel.b) || { name: 'Игрок', characterId: 'rouge' };
    $('#duelNameA').textContent = pA.name; $('#duelNameB').textContent = pB.name;
    $('#duelAvatarA').src = getChar(pA.characterId)?.image || '/assets/characters/madley.png';
    $('#duelAvatarB').src = getChar(pB.characterId)?.image || '/assets/characters/rouge.png';
    $('#roundNumber').textContent = String(state.duel.round || 1);
  }
  function updateDuelHealth(m = {}) {
    if (!state.duel) return;
    if (m.hp) state.duel.hp = m.hp;
    $('#hpBarA').style.width = `${Math.max(0,state.duel.hp[state.duel.a] ?? 100)}%`;
    $('#hpBarB').style.width = `${Math.max(0,state.duel.hp[state.duel.b] ?? 100)}%`;
  }
  function updateDuelTurn(m) {
    if (!state.duel) return;
    Object.assign(state.duel, { turn: m.turn, round: m.round, phase: m.phase || 'attack' }); updateDuelNames(); updateDuelHealth(m);
    state.dodge = null; $('#timerFill').style.transform = 'scaleX(1)'; $('#attackActions').style.visibility = 'visible';
    const myTurn = state.duel.turn === state.currentId;
    $('#battleTitle').textContent = myTurn ? 'Твой ход атаковать' : 'Ход соперника';
    $('#battleHint').textContent = myTurn ? 'Выбери уникальную атаку своего персонажа.' : 'Соперник выбирает атаку. Приготовься уклоняться!';
    const char = getChar(state.characterId); $('#attackLabel').textContent = char?.attack || 'Атака';
    $('#attackButton').disabled = !myTurn;
    $('#dodgeCanvas').getContext('2d').clearRect(0,0,640,300); $('#heartGlyph').style.display = 'none';
  }
  function beginDodge(m) {
    if (!state.duel) return;
    Object.assign(state.duel, { phase: 'dodge', round: m.round, hp: m.hp || state.duel.hp }); updateDuelHealth(m); updateDuelNames();
    state.dodge = { start: performance.now(), duration: m.duration || 6800, pattern: m.pattern || 'carrot', seed: m.seed || 1,
      attacker: m.attacker, defender: m.defender, name: m.attackName || 'Атака' };
    state.heart = { x: .5, y: .73 }; state.dodgeHits = new Set(); state.dodgeScoreSent = false;
    const defending = m.defender === state.currentId;
    $('#battleTitle').textContent = defending ? 'Уклоняйся!' : 'Атака';
    $('#battleHint').textContent = defending ? `Уклоняйся от атаки «${m.attackName}» · двигайся WASD / стрелками` : `${m.attackName} — соперник уворачивается`;
    $('#attackButton').disabled = true; $('#attackActions').style.visibility = defending ? 'hidden' : 'visible';
    $('#heartGlyph').style.display = 'block';
    $('#arenaCaption').textContent = defending ? 'ТЫ УПРАВЛЯЕШЬ ♥' : 'НАБЛЮДАЙ';
  }
  function showDuelResult(m) {
    if (!state.duel) return;
    state.duel.hp = m.hp; state.duel.round = m.round; state.duel.phase = 'result'; updateDuelHealth(m);
    const defending = m.defenderId === state.currentId;
    $('#battleTitle').textContent = defending ? (m.damage <= 11 ? 'Отличный манёвр!' : 'Тебя задело!') : 'Попадание!';
    $('#battleHint').textContent = defending ? `Уклонение ${Math.round(m.dodged * 100)}% · получено ${m.damage} урона` : `Соперник получил ${m.damage} урона. Скоро следующий ход…`;
    $('#attackActions').style.visibility = 'hidden'; $('#heartGlyph').style.display = 'none';
    if (defending) toast(m.damage <= 11 ? `Хорошо увернулся! −${m.damage} HP` : `Попадание! −${m.damage} HP`, m.damage <= 11 ? 'success' : 'warn');
  }
  function finishDuel(m) {
    if (!state.duel) return;
    const previousWins = state.profile.wins;
    state.profile.battles++;
    if (m.won) state.profile.wins++;
    saveProfile();
    const won = !!m.won;
    $('#battleTitle').textContent = won ? 'Победа! ✦' : m.winnerId ? 'В этот раз без победы' : 'Бой окончен';
    $('#battleHint').textContent = won ? 'Отличный бой! Персонажи и достижения уже обновлены.' : m.reason === 'forfeit' ? 'Ты покинул дуэль.' : 'Попробуй ещё раз — скоро найдёшь свой ритм.';
    $('#attackActions').style.visibility = 'hidden'; $('#heartGlyph').style.display = 'none';
    toast(won ? 'Победа! Прогресс сохранён.' : 'Дуэль завершена.', won ? 'success' : '');
    if (state.profile.wins > previousWins) {
      const newly = state.characters.filter(c => !isUnlockedBefore(c, previousWins, state.profile.battles - 1)).filter(isUnlocked);
      if (newly.length) setTimeout(() => toast(`Открыт персонаж: ${newly[0].name} ✨`, 'success'), 500);
    }
    setTimeout(() => { $('#battlePanel').classList.add('hidden'); state.duel = null; state.dodge = null; }, 3200);
  }
  function isUnlockedBefore(char, wins, battles) {
    if (char.unlock.type === 'starter') return true;
    const v = char.unlock.type === 'wins' ? wins : char.unlock.type === 'battles' ? battles : unlockValue(char.unlock.type);
    return v >= char.unlock.value;
  }
  function attackNow() {
    if (!state.duel || state.duel.turn !== state.currentId || state.duel.phase !== 'attack') return;
    $('#attackButton').disabled = true; $('#battleTitle').textContent = 'Атака отправлена!';
    $('#battleHint').textContent = 'Соперник пытается увернуться…'; send('attack');
  }
  function handleDodgeFinish() {
    if (!state.dodge || state.dodgeScoreSent || state.dodge.defender !== state.currentId) return;
    state.dodgeScoreSent = true;
    const possible = Math.max(1, Math.floor(6.8 / .28));
    const score = Math.max(.04, Math.min(.97, 1 - state.dodgeHits.size / possible * 1.55));
    send('dodgeScore', { score }); $('#battleTitle').textContent = 'Манёвр завершён';
    $('#battleHint').textContent = `Расчёт уклонения… ${(score * 100).toFixed(0)}%`; $('#attackActions').style.visibility = 'hidden';
  }

  function frame(now) {
    const dt = Math.min(.05, Math.max(0, (now - state.lastFrame) / 1000)); state.lastFrame = now;
    updateMovement(dt); drawWorld(now); drawDodge(now, dt); requestAnimationFrame(frame);
  }
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * dpr); canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = `${innerWidth}px`; canvas.style.height = `${innerHeight}px`;
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  function updateMovement(dt) {
    if (!state.started || state.duel) return;
    let x = 0, y = 0;
    if (state.keys.has('a') || state.keys.has('arrowleft')) x--;
    if (state.keys.has('d') || state.keys.has('arrowright')) x++;
    if (state.keys.has('w') || state.keys.has('arrowup')) y--;
    if (state.keys.has('s') || state.keys.has('arrowdown')) y++;
    if (x || y) { const l = Math.hypot(x,y); state.input = { x:x/l, y:y/l }; }
    else if (!state.mobilePointer) state.input = { x:0, y:0 };
    const p = state.players.find(x => x.id === state.currentId);
    if (p && (state.input.x || state.input.y)) { const k = .34 * dt; p.x = Math.min(.965,Math.max(.035,p.x + state.input.x*k)); p.y = Math.min(.91,Math.max(.12,p.y + state.input.y*k)); p.moving = true; }
    else if (p) p.moving = false;
    if (nowTime() - state.lastMoveSent > 70) { send('move', state.input); state.lastMoveSent = nowTime(); }
  }
  function nowTime() { return performance.now(); }
  function drawWorld(now) {
    const w = innerWidth, h = innerHeight;
    ctx.clearRect(0,0,w,h);
    const loc = state.map || getLocation(state.mapId), image = getMapImage(loc);
    if (image?.complete && image.naturalWidth) {
      const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
      const dw = image.naturalWidth * scale, dh = image.naturalHeight * scale;
      ctx.drawImage(image, (w-dw)/2, (h-dh)/2, dw, dh);
      ctx.fillStyle = loc.mood === 'dark' ? 'rgba(7,9,16,.32)' : 'rgba(9,13,22,.22)'; ctx.fillRect(0,0,w,h);
    } else {
      const g = ctx.createLinearGradient(0,0,w,h); g.addColorStop(0,'#344452'); g.addColorStop(.52,'#4e5a60'); g.addColorStop(1,'#151a26'); ctx.fillStyle = g; ctx.fillRect(0,0,w,h);
      ctx.fillStyle = '#ffffff10'; for(let i=0;i<12;i++){ctx.beginPath();ctx.arc((i*173)%w,(i*91)%h,28+(i%4)*12,0,Math.PI*2);ctx.fill();}
    }
    // Moving dust / glow adds a little life without covering the original art.
    for (let i=0;i<17;i++) {
      const x = ((i*179 + now*.009*(i%3+1)) % (w+30))-15;
      const y = ((i*97 + Math.sin(now*.00045+i)*23) % h);
      ctx.beginPath(); ctx.fillStyle = i%4===0 ? '#d7ffad40' : '#ffffff23'; ctx.arc(x,y,i%4===0?2:1.2,0,Math.PI*2); ctx.fill();
    }
    const list = [...state.players].sort((a,b) => (a.y||0)-(b.y||0));
    for (const p of list) drawPlayer(p, w, h, now);
    updateSpeechBubbles(w, h, now);
  }
  function playerLayout(p, w, h, now) {
    const x = (p.x ?? .5) * w, baseY = (p.y ?? .6) * h;
    const self = p.id === state.currentId, moving = p.moving || (self && (state.input.x || state.input.y));
    const bob = Math.sin(now * .006 + (p.id.charCodeAt(0) || 1)) * (moving ? 3.5 : 1.6);
    const scale = Math.max(.76, Math.min(1.18, Math.min(w / 1100, h / 700)));
    // About 1.65x the previous sprite size, with the same feet/world coordinates.
    const sw = 102 * scale, sh = 116 * scale, sy = baseY - sh + bob;
    return { x, baseY, scale, sw, sh, sy, nameY: sy - 25 * scale };
  }
  function drawPlayer(p,w,h,now) {
    const char = getChar(p.characterId); if (!char) return;
    const { x, baseY, scale, sw, sh, sy, nameY } = playerLayout(p, w, h, now);
    const self = p.id === state.currentId;
    ctx.save(); ctx.globalAlpha=.25; ctx.fillStyle='#000'; ctx.beginPath(); ctx.ellipse(x,baseY+2,32*scale,8*scale,0,0,Math.PI*2); ctx.fill(); ctx.restore();
    if(self){ctx.strokeStyle='#d3ff83aa';ctx.lineWidth=2;ctx.beginPath();ctx.ellipse(x,baseY+1,40*scale,10*scale,0,0,Math.PI*2);ctx.stroke();}
    let im=images.get(`char:${char.id}`);
    if(!im){im=new Image();im.src=char.image;images.set(`char:${char.id}`,im);}
    if(im.complete&&im.naturalWidth){ctx.save();ctx.shadowColor=self?'#b8f06b66':'#00000033';ctx.shadowBlur=self?14:7;ctx.drawImage(im,x-sw/2,sy,sw,sh);ctx.restore();}
    else {ctx.fillStyle=self?'#cbff6c':'#ab8cff';ctx.beginPath();ctx.arc(x,sy+sh*.45,16*scale,0,Math.PI*2);ctx.fill();}
    const name = p.name || 'Странник'; ctx.font=`700 ${Math.max(10,11*scale)}px system-ui`; const tw=ctx.measureText(name).width;
    const bw=Math.min(Math.max(50,tw+18),180), bh=20*scale, bx=x-bw/2, by=nameY;
    roundedRect(ctx,bx,by,bw,bh,7*scale); ctx.fillStyle=self?'rgba(20,28,20,.84)':'rgba(12,15,23,.76)';ctx.fill();
    if(self){ctx.strokeStyle='#d2ff6b9a';ctx.lineWidth=1;roundedRect(ctx,bx,by,bw,bh,7*scale);ctx.stroke();}
    ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(name,x,by+bh/2, bw-8);
  }
  function roundedRect(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}

  function drawDodge(now,dt) {
    if (!state.duel || !state.dodge) return;
    const d = state.dodge, c = $('#dodgeCanvas'), g = c.getContext('2d');
    const elapsed = now-d.start, t = elapsed/1000, left = Math.max(0,1-elapsed/d.duration);
    $('#timerFill').style.transform = `scaleX(${left})`;
    const defending = d.defender === state.currentId;
    if (defending && !state.dodgeScoreSent) {
      const speed = 0.42*dt;
      let dx=0,dy=0;
      if(state.keys.has('a')||state.keys.has('arrowleft'))dx--;
      if(state.keys.has('d')||state.keys.has('arrowright'))dx++;
      if(state.keys.has('w')||state.keys.has('arrowup'))dy--;
      if(state.keys.has('s')||state.keys.has('arrowdown'))dy++;
      if(dx||dy){const l=Math.hypot(dx,dy);state.heart.x=Math.max(.035,Math.min(.965,state.heart.x+dx/l*speed));state.heart.y=Math.max(.08,Math.min(.92,state.heart.y+dy/l*speed));}
    }
    g.clearRect(0,0,640,300);g.fillStyle='#080a11';g.fillRect(0,0,640,300);
    g.strokeStyle='#252939';g.lineWidth=1;for(let x=0;x<=640;x+=40){g.beginPath();g.moveTo(x,0);g.lineTo(x,300);g.stroke();}for(let y=0;y<=300;y+=40){g.beginPath();g.moveTo(0,y);g.lineTo(640,y);g.stroke();}
    g.save();g.globalAlpha=.14;g.fillStyle='#d9ff70';g.beginPath();g.arc(320,150,74+Math.sin(now*.003)*4,0,Math.PI*2);g.fill();g.restore();
    const bullets=bulletsAt(d.pattern,t,d.seed);
    let active=0;
    for(const b of bullets){ if(b.x<-25||b.x>665||b.y<-25||b.y>325) continue; active++;
      g.save();g.translate(b.x,b.y);g.rotate(b.rot||0);g.fillStyle=b.color||'#ff8b69';g.shadowColor=b.color||'#ff8b69';g.shadowBlur=11;
      if(b.shape==='diamond'){g.beginPath();g.moveTo(0,-b.r);g.lineTo(b.r,0);g.lineTo(0,b.r);g.lineTo(-b.r,0);g.closePath();g.fill();}
      else if(b.shape==='tri'){g.beginPath();g.moveTo(0,-b.r*1.5);g.lineTo(b.r,b.r);g.lineTo(-b.r,b.r);g.closePath();g.fill();}
      else{g.beginPath();g.arc(0,0,b.r||6,0,Math.PI*2);g.fill();g.fillStyle='#fff8';g.beginPath();g.arc(-1,-1,Math.max(1,(b.r||6)*.35),0,Math.PI*2);g.fill();}
      g.restore();
      const hx=state.heart.x*640,hy=state.heart.y*300,dist=Math.hypot(hx-b.x,hy-b.y);
      if(defending&&!state.dodgeScoreSent&&dist<(b.r||6)+7&&!state.dodgeHits.has(b.key)){
        state.dodgeHits.add(b.key); $('#heartGlyph').style.filter='drop-shadow(0 0 9px red)'; setTimeout(()=>$('#heartGlyph').style.filter='',170);
      }
    }
    const heart=$('#heartGlyph');heart.style.left=`${state.heart.x*100}%`;heart.style.top=`${state.heart.y*100}%`;
    if(defending){g.save();g.strokeStyle='#ffffff48';g.lineWidth=1;g.beginPath();g.arc(state.heart.x*640,state.heart.y*300,11,0,Math.PI*2);g.stroke();g.restore();}
    if(elapsed>=d.duration&&!state.dodgeScoreSent&&defending)handleDodgeFinish();
  }
  function hash(n){let x=(n|0)^0x45d9f3b;x=Math.imul(x^(x>>>16),0x45d9f3b);x=Math.imul(x^(x>>>16),0x45d9f3b);return ((x^(x>>>16))>>>0)/4294967295;}
  function bulletsAt(pattern,t,seed){
    const out=[]; const push=(key,x,y,r=6,color='#ff8a70',shape='circle',rot=0)=>out.push({key,x,y,r,color,shape,rot});
    const groups=Math.floor(t/.34)+1;
    for(let i=0;i<groups;i++){
      const st=i*.34,age=t-st;if(age<0||age>3.0)continue;
      const r=hash(seed+i*13),q=hash(seed+i*31+5),id=`${pattern}-${i}`;
      if(pattern==='rain'||pattern==='carrot'||pattern==='rock'||pattern==='snow'||pattern==='confetti'){
        const x=35+r*570+Math.sin(i*.7)*20, y=-12+age*(pattern==='rock'?130:105+q*72);
        push(id,x,y,pattern==='carrot'?7:6,pattern==='snow'?'#a9e8ff':pattern==='rock'?'#d6bd93':pattern==='confetti'?'#e09cff':'#ffad65',pattern==='carrot'?'tri':'circle',age*2);
      } else if(pattern==='ghost'||pattern==='void'||pattern==='sniper'){
        const side=i%2?640:0,sgn=side? -1:1, y=45+q*210;
        push(id,side+sgn*age*(pattern==='void'?145:120),y+Math.sin(age*4+i)*18,pattern==='void'?9:7,pattern==='ghost'?'#bba1ff':pattern==='void'?'#b0eaff':'#ff777f',pattern==='void'?'diamond':'circle',age*2);
      } else if(pattern==='fan'||pattern==='spear'||pattern==='shadow'||pattern==='dash'){
        const side=i%2?640:0,sgn=side?-1:1,y=25+q*250;
        const dy=pattern==='fan'?Math.sin((r-.5)*1.8)*.45:pattern==='spear'?.48:pattern==='shadow'?Math.sin(i*1.5)*.28:0;
        push(id,side+sgn*age*(pattern==='dash'?185:140),y+age*dy*140,pattern==='spear'?8:6,pattern==='spear'?'#f7e5a5':pattern==='shadow'?'#9f82ff':'#ff7ba8',pattern==='spear'?'tri':'diamond',sgn*.6);
      } else if(pattern==='spiral'||pattern==='poison'||pattern==='burst'||pattern==='quake'||pattern==='pulse'){
        const count=pattern==='burst'?12:7; const angle=i*.47+age*(pattern==='poison'?1.6:1.15);
        const rad=pattern==='pulse'?32+((i%4)*23)+age*26:pattern==='quake'?32+age*85:36+age*55;
        const bx=320+Math.cos(angle+i*2*Math.PI/count)*rad,by=150+Math.sin(angle+i*2*Math.PI/count)*rad;
        push(id,bx,by,pattern==='poison'?7:6,pattern==='poison'?'#b3f16b':pattern==='pulse'?'#ff75c4':'#ffc76f',pattern==='poison'?'diamond':'circle',angle);
      } else if(pattern==='twins'||pattern==='dance'){
        const x=age*155+(i%2?640:0),sgn=i%2?-1:1;
        const y=70+(i%2?95:0)+Math.sin(age*4+i*.4)*70;
        push(id,x*sgn+(sgn<0?640:0),y,7,pattern==='twins'?'#7fe8f0':'#d18cff','diamond',age*2);
      } else {
        const x=320+Math.cos(i*.85+age)*100+age*18,y=150+Math.sin(i*.85+age)*90;
        push(id,x,y,6,'#ff9279');
      }
    }
    if(pattern==='burst'&&t<3.1){
      const group=Math.floor(t/.95),age=t-group*.95;
      for(let j=0;j<10;j++){const a=j*Math.PI/5+group*.22;push(`burst-${group}-${j}`,320+Math.cos(a)*age*100,150+Math.sin(a)*age*90,6,'#ff80b8','diamond',a);}
    }
    return out;
  }

  function setupInputs() {
    window.addEventListener('pointerdown',()=>{if(state.audio?.state==='suspended')state.audio.resume().catch(()=>{});},{once:true});
    window.addEventListener('resize',resize);
    window.addEventListener('keydown',e=>{
      const key=e.key.toLowerCase();
      if(['arrowup','arrowdown','arrowleft','arrowright',' '].includes(key) && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) e.preventDefault();
      state.keys.add(key);
      if(['INPUT','TEXTAREA'].includes(document.activeElement.tagName))return;
      if(key==='m'){showMaps();} if(key==='c'){openCharacters();} if(key==='j'){showAchievements();} if(key==='f'){
        const p=state.players.find(x=>x.id!==state.currentId); if(p)challenge(p.id); else toast('Поблизости пока нет соперников.');
      }
      if(key==='escape'&&modalRoot.firstElementChild)closeModal();
    });
    window.addEventListener('keyup',e=>state.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur',()=>{state.keys.clear();state.input={x:0,y:0};});
    $('#chatForm').addEventListener('submit',e=>{e.preventDefault();const input=$('#chatInput'),text=input.value.trim();if(!text)return;if(state.socket?.readyState!==WebSocket.OPEN){toast('Нет соединения с сервером.');return;}send('chat',{text});input.value='';input.focus();});
    $('#chatMinButton').addEventListener('click',()=>{state.chatCollapsed=!state.chatCollapsed;$('#chatPanel').classList.toggle('chat-collapsed',state.chatCollapsed);$('#chatMinButton').textContent=state.chatCollapsed?'⌃':'⌄';});
    $('#locationButton').addEventListener('click',showMaps);$('#mapShortcut').addEventListener('click',showMaps);
    $('#characterButton').addEventListener('click',openCharacters);$('#characterShortcut').addEventListener('click',openCharacters);
    $('#achievementShortcut').addEventListener('click',showAchievements);
    $('#duelShortcut').addEventListener('click',()=>{const p=state.players.find(x=>x.id!==state.currentId);if(p)challenge(p.id);else toast('Поблизости пока нет соперников. Пригласи друга по ссылке!');});
    $('#fullscreenButton').addEventListener('click',toggleFullscreen);
    $('#soundButton').addEventListener('click',()=>{state.soundOn=!state.soundOn;setSoundButton();if(state.soundOn)startMusic();else stopMusic();});
    $('#attackButton').addEventListener('click',attackNow);$('#leaveDuelButton').addEventListener('click',()=>{if(state.duel){send('leaveDuel');}});
    $('#acceptChallengeButton').addEventListener('click',()=>{if(state.incoming)send('acceptChallenge',{challengeId:state.incoming.challengeId});$('#incomingChallenge').classList.add('hidden');});
    $('#declineChallengeButton').addEventListener('click',()=>{if(state.incoming)send('declineChallenge',{challengeId:state.incoming.challengeId});state.incoming=null;$('#incomingChallenge').classList.add('hidden');});
    canvas.addEventListener('click',e=>{
      const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
      for (const p of [...state.players].sort((a,b) => b.y - a.y)) if (p.id !== state.currentId) {
        const { x: px, baseY, sw, sy } = playerLayout(p, innerWidth, innerHeight, performance.now());
        if (x >= px - sw / 2 - 8 && x <= px + sw / 2 + 8 && y >= sy - 6 && y <= baseY + 12) { challenge(p.id); return; }
      }
    });
    setupTouch();
    $('#dodgeCanvas').addEventListener('pointermove',e=>{
      if(!state.dodge||state.dodge.defender!==state.currentId||state.dodgeScoreSent)return;
      const r=e.currentTarget.getBoundingClientRect();state.heart.x=Math.max(.03,Math.min(.97,(e.clientX-r.left)/r.width));state.heart.y=Math.max(.06,Math.min(.94,(e.clientY-r.top)/r.height));
    });
    $('#dodgeCanvas').addEventListener('pointerdown',e=>{e.currentTarget.setPointerCapture?.(e.pointerId);});
    document.addEventListener('visibilitychange',()=>{if(document.hidden){state.keys.clear();state.input={x:0,y:0};}});
  }
  function setupTouch(){
    const pad=$('#touchPad'),knob=$('#touchKnob');if(!pad)return;
    const move=e=>{if(state.mobilePointer!==e.pointerId)return;const r=pad.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,dx=e.clientX-cx,dy=e.clientY-cy,max=42,len=Math.hypot(dx,dy),k=len>max?max/len:1;const x=dx*k,y=dy*k;knob.style.transform=`translate(calc(-50% + ${x}px),calc(-50% + ${y}px))`;state.input={x:x/max,y:y/max};};
    pad.addEventListener('pointerdown',e=>{state.mobilePointer=e.pointerId;pad.setPointerCapture(e.pointerId);move(e);});
    pad.addEventListener('pointermove',move);
    const end=e=>{if(state.mobilePointer!==e.pointerId)return;state.mobilePointer=null;knob.style.transform='translate(-50%,-50%)';if(!state.keys.size)state.input={x:0,y:0};};
    pad.addEventListener('pointerup',end);pad.addEventListener('pointercancel',end);
    $('#touchChatButton').addEventListener('click',()=>$('#chatPanel').classList.toggle('chat-collapsed'));
  }
  function toggleFullscreen(){
    if(!document.fullscreenElement)document.documentElement.requestFullscreen?.().catch(()=>{});else document.exitFullscreen?.();
  }

  function setSoundButton(){ $('#soundIcon').textContent=state.soundOn?'♫':'♪̸';$('#soundButton').title=state.soundOn?'Музыка: вкл':'Музыка: выкл'; }
  function startMusic(){
    if(!state.soundOn)return;stopMusic();
    try{state.audio ||= new (window.AudioContext||window.webkitAudioContext)();if(state.audio.state==='suspended')state.audio.resume();}catch{return;}
    const loc=getLocation(state.mapId);if(!loc)return;
    let seed=0;for(const ch of loc.id)seed=(seed*31+ch.charCodeAt(0))|0;seed=Math.abs(seed);
    const scales={dark:[0,3,5,6,10],dream:[0,2,5,7,9],town:[0,2,4,7,9],chill:[0,2,3,7,10],arcade:[0,4,5,7,11]};
    const scale=scales[loc.mood]||scales.arcade, tempo=loc.mood==='dark'?530:loc.mood==='dream'?610:loc.mood==='chill'?680:loc.mood==='town'?570:460;
    state.musicStep=0;
    const tick=()=>{
      if(!state.soundOn||!state.audio||!state.started)return;
      const ac=state.audio,step=state.musicStep++,note=scale[(Math.floor(step*1.7)+seed)%scale.length],octave=(step%8===0?0:step%4===0?1:2);
      const freq=110*Math.pow(2,(note+octave*12)/12); const osc=ac.createOscillator(),gain=ac.createGain();
      osc.type=loc.mood==='dream'?'sine':loc.mood==='dark'?'triangle':'triangle';osc.frequency.setValueAtTime(freq,ac.currentTime);
      gain.gain.setValueAtTime(.0001,ac.currentTime);gain.gain.exponentialRampToValueAtTime(.025,ac.currentTime+.035);gain.gain.exponentialRampToValueAtTime(.0001,ac.currentTime+.42);
      osc.connect(gain);gain.connect(ac.destination);osc.start();osc.stop(ac.currentTime+.45);
      if(step%4===0){const bass=ac.createOscillator(),bg=ac.createGain();bass.type='sine';bass.frequency.value=freq/2;bg.gain.setValueAtTime(.0001,ac.currentTime);bg.gain.exponentialRampToValueAtTime(.016,ac.currentTime+.06);bg.gain.exponentialRampToValueAtTime(.0001,ac.currentTime+.6);bass.connect(bg);bg.connect(ac.destination);bass.start();bass.stop(ac.currentTime+.62);}
      state.musicTimer=setTimeout(tick,tempo+(seed%71));
    };
    tick();
  }
  function stopMusic(){clearTimeout(state.musicTimer);state.musicTimer=null;}

  init().catch(err=>{console.error(err);setConnection('disconnected','Не удалось загрузить ресурсы');toast('Ошибка загрузки данных игры. Обнови страницу.','warn');});
})();
