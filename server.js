'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const characters = require('./public/characters.json');
const locations = require('./public/locations.json');
const characterById = new Map(characters.map(c => [c.id, c]));
const locationById = new Map(locations.map(l => [l.id, l]));
const app = express();
app.disable('x-powered-by');
const shellFiles = new Set(['index.html', 'game.js', 'styles.css', 'sw.js', 'manifest.json', 'characters.json', 'locations.json']);
app.use(express.static(PUBLIC, {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true,
  setHeaders(res, file) {
    // Revalidate the application shell so existing players receive game updates.
    if (shellFiles.has(path.basename(file))) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.get('/health', (_req, res) => res.json({ ok: true, players: players.size, duels: duels.size }));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 8192 });

const players = new Map(); // id -> server-authoritative public state
const sockets = new Map(); // ws -> player id
const duels = new Map();
const duelByPlayer = new Map();
const challenges = new Map();
const lastChat = new Map();

function send(ws, type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
}
function tellPlayer(id, type, data = {}) {
  for (const [ws, pid] of sockets) if (pid === id) send(ws, type, data);
}
function broadcast(type, data = {}) {
  const packet = JSON.stringify({ type, ...data });
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(packet);
}
function cleanText(value, max = 24) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
function snapshot(player) {
  return {
    id: player.id, name: player.name, characterId: player.characterId,
    mapId: player.mapId, x: player.x, y: player.y, moving: !!(player.ix || player.iy)
  };
}
function sendWorld() {
  const all = [...players.values()].map(snapshot);
  for (const [ws, id] of sockets) {
    const own = players.get(id);
    if (own) send(ws, 'world', { players: all.filter(p => p.mapId === own.mapId), online: players.size });
  }
}
function duelPacket(duel) {
  return { duelId: duel.id, a: duel.a, b: duel.b, hp: { ...duel.hp }, turn: duel.turn,
    round: duel.round, phase: duel.phase };
}
function endDuel(duel, winnerId, reason = 'finished') {
  if (!duel || duel.ended) return;
  duel.ended = true;
  clearTimeout(duel.timer);
  duels.delete(duel.id);
  duelByPlayer.delete(duel.a);
  duelByPlayer.delete(duel.b);
  for (const id of [duel.a, duel.b]) tellPlayer(id, 'duelEnd', {
    winnerId: winnerId || null, won: !!winnerId && winnerId === id, reason, state: duelPacket(duel)
  });
}
function settleDodge(duel, score = 0.35) {
  if (!duel || duel.ended || duel.phase !== 'dodge') return;
  clearTimeout(duel.timer);
  const defenderId = duel.defender;
  const safe = Math.max(0, Math.min(1, Number(score) || 0));
  const damage = Math.max(4, Math.min(30, 9 + Math.round((1 - safe) * 17) + Math.floor(Math.random() * 3)));
  duel.hp[defenderId] = Math.max(0, duel.hp[defenderId] - damage);
  duel.phase = 'result';
  for (const id of [duel.a, duel.b]) tellPlayer(id, 'duelResult', {
    ...duelPacket(duel), defenderId, damage, dodged: safe, attackName: duel.attackName
  });
  if (duel.hp[defenderId] <= 0) {
    duel.timer = setTimeout(() => endDuel(duel, duel.attacker, 'knockout'), 1800);
    return;
  }
  duel.timer = setTimeout(() => {
    if (duel.ended) return;
    duel.turn = defenderId;
    duel.round++;
    duel.phase = 'attack';
    duel.attacker = null;
    duel.defender = null;
    for (const id of [duel.a, duel.b]) tellPlayer(id, 'duelTurn', duelPacket(duel));
  }, 1700);
}
function startDuel(challenge) {
  const a = players.get(challenge.from), b = players.get(challenge.to);
  if (!a || !b || duelByPlayer.has(a.id) || duelByPlayer.has(b.id)) return false;
  const duel = { id: randomUUID(), a: a.id, b: b.id, hp: { [a.id]: 100, [b.id]: 100 },
    turn: a.id, round: 1, phase: 'attack', attacker: null, defender: null, ended: false, timer: null };
  duels.set(duel.id, duel);
  duelByPlayer.set(a.id, duel.id);
  duelByPlayer.set(b.id, duel.id);
  for (const id of [a.id, b.id]) tellPlayer(id, 'duelStart', {
    ...duelPacket(duel), players: { [a.id]: snapshot(a), [b.id]: snapshot(b) }
  });
  return true;
}
function onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (!msg || typeof msg.type !== 'string') return;
  let id = sockets.get(ws);
  if (msg.type === 'join') {
    if (id) return;
    const requestedCharacter = cleanText(msg.characterId, 40);
    const requestedMap = cleanText(msg.mapId, 40);
    id = randomUUID();
    const player = {
      id, name: cleanText(msg.name || 'Гость', 22) || 'Гость',
      characterId: characterById.has(requestedCharacter) ? requestedCharacter : 'madley',
      mapId: locationById.has(requestedMap) ? requestedMap : 'map-006',
      x: 0.42 + Math.random() * 0.16, y: 0.43 + Math.random() * 0.15, ix: 0, iy: 0,
      lastChat: 0
    };
    players.set(id, player);
    sockets.set(ws, id);
    send(ws, 'joined', { id, player: snapshot(player), online: players.size });
    broadcast('notice', { text: `${player.name} присоединился к миру` });
    sendWorld();
    return;
  }
  if (!id) return;
  const player = players.get(id);
  if (!player) return;
  if (msg.type === 'move') {
    if (duelByPlayer.has(id)) return;
    player.ix = Math.max(-1, Math.min(1, Number(msg.x) || 0));
    player.iy = Math.max(-1, Math.min(1, Number(msg.y) || 0));
  } else if (msg.type === 'travel') {
    const next = cleanText(msg.mapId, 40);
    if (!locationById.has(next) || next === player.mapId) return;
    const previous = player.mapId;
    player.mapId = next;
    player.x = 0.45 + Math.random() * 0.1;
    player.y = 0.48 + Math.random() * 0.08;
    player.ix = 0; player.iy = 0;
    tellPlayer(id, 'travelled', { mapId: next });
    broadcast('notice', { text: `${player.name} отправился в ${locationById.get(next).name}` });
    sendWorld();
  } else if (msg.type === 'character') {
    const next = cleanText(msg.characterId, 40);
    if (!characterById.has(next)) return;
    player.characterId = next;
    broadcast('notice', { text: `${player.name} сменил персонажа` });
    sendWorld();
  } else if (msg.type === 'chat') {
    const now = Date.now();
    if (now - (lastChat.get(id) || 0) < 650) return;
    const text = cleanText(msg.text, 180);
    if (!text) return;
    lastChat.set(id, now);
    const packet = { id: randomUUID(), playerId: id, name: player.name, characterId: player.characterId, text, time: now };
    for (const [client, clientId] of sockets) {
      const recipient = players.get(clientId);
      if (recipient && recipient.mapId === player.mapId) send(client, 'chat', packet);
    }
  } else if (msg.type === 'challenge') {
    const target = cleanText(msg.targetId, 64);
    const other = players.get(target);
    if (!other || target === id || duelByPlayer.has(id) || duelByPlayer.has(target)) return;
    for (const c of challenges.values()) if ((c.from === id && c.to === target) || (c.from === target && c.to === id)) return;
    const challenge = { id: randomUUID(), from: id, to: target, timer: null };
    challenge.timer = setTimeout(() => { challenges.delete(challenge.id); tellPlayer(challenge.to, 'challengeExpired', { challengeId: challenge.id }); }, 20000);
    challenges.set(challenge.id, challenge);
    tellPlayer(target, 'challengeIncoming', { challengeId: challenge.id, from: snapshot(player) });
    tellPlayer(id, 'challengeSent', { target: snapshot(other) });
  } else if (msg.type === 'acceptChallenge') {
    const challengeId = cleanText(msg.challengeId, 64);
    const challenge = challenges.get(challengeId);
    if (!challenge || challenge.to !== id) return;
    clearTimeout(challenge.timer);
    challenges.delete(challengeId);
    if (!startDuel(challenge)) {
      tellPlayer(challenge.from, 'notice', { text: 'Соперник уже недоступен.' });
      tellPlayer(id, 'notice', { text: 'Нельзя начать дуэль: игрок уже занят.' });
    }
  } else if (msg.type === 'declineChallenge') {
    const challenge = challenges.get(cleanText(msg.challengeId, 64));
    if (!challenge || challenge.to !== id) return;
    clearTimeout(challenge.timer); challenges.delete(challenge.id);
    tellPlayer(challenge.from, 'challengeDeclined', { name: player.name });
  } else if (msg.type === 'attack') {
    const duelId = duelByPlayer.get(id), duel = duels.get(duelId);
    if (!duel || duel.phase !== 'attack' || duel.turn !== id) return;
    const attacker = players.get(id);
    const character = characterById.get(attacker.characterId) || characterById.get('madley');
    duel.attacker = id;
    duel.defender = id === duel.a ? duel.b : duel.a;
    duel.attackName = character.attack;
    duel.pattern = character.pattern;
    duel.phase = 'dodge';
    duel.seed = Math.floor(Math.random() * 0x7fffffff);
    for (const pid of [duel.a, duel.b]) tellPlayer(pid, 'dodgeStart', {
      ...duelPacket(duel), attacker: duel.attacker, defender: duel.defender,
      pattern: duel.pattern, attackName: duel.attackName, seed: duel.seed, duration: 6800
    });
    duel.timer = setTimeout(() => settleDodge(duel, 0.25), 7600);
  } else if (msg.type === 'dodgeScore') {
    const duel = duels.get(duelByPlayer.get(id));
    if (!duel || duel.phase !== 'dodge' || duel.defender !== id) return;
    settleDodge(duel, msg.score);
  } else if (msg.type === 'leaveDuel') {
    const duel = duels.get(duelByPlayer.get(id));
    if (duel) endDuel(duel, id === duel.a ? duel.b : duel.a, 'forfeit');
  }
}

wss.on('connection', ws => {
  ws.on('message', data => onMessage(ws, data));
  ws.on('close', () => {
    const id = sockets.get(ws);
    if (!id) return;
    const player = players.get(id);
    const duel = duels.get(duelByPlayer.get(id));
    if (duel) endDuel(duel, id === duel.a ? duel.b : duel.a, 'disconnect');
    for (const [cid, challenge] of challenges) {
      if (challenge.from === id || challenge.to === id) {
        clearTimeout(challenge.timer); challenges.delete(cid);
        tellPlayer(challenge.from === id ? challenge.to : challenge.from, 'challengeExpired', { challengeId: cid });
      }
    }
    players.delete(id); sockets.delete(ws); lastChat.delete(id);
    if (player) broadcast('notice', { text: `${player.name} покинул мир` });
    sendWorld();
  });
  ws.on('error', () => {});
});

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  for (const p of players.values()) {
    if (duelByPlayer.has(p.id)) continue;
    const length = Math.hypot(p.ix, p.iy) || 1;
    const speed = 0.34 * dt / length;
    p.x = Math.max(0.035, Math.min(0.965, p.x + p.ix * speed));
    p.y = Math.max(0.12, Math.min(0.91, p.y + p.iy * speed));
  }
}, 40);
setInterval(sendWorld, 100);

server.listen(PORT, '0.0.0.0', () => console.log(`Gith World RP running on port ${PORT}`));
