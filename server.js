/* Dark Gramm — сервер (Node.js + ws)
   Запуск:  npm i ws  &&  node server.js
   Render:  Build = npm i, Start = node server.js (порт берётся из PORT) */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8080;

/* ---------- база аккаунтов (файл users.json) ---------- */
const DB_FILE = path.join(__dirname, 'users.json');
let users = {}; try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(DB_FILE, JSON.stringify(users), () => {}); } }, 3000);
const hash = (p, s) => crypto.createHash('sha256').update(s + p).digest('hex');

const server = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('Dark Gramm server OK'); });
const wss = new WebSocketServer({ server });
const clients = new Map(); // ws -> player
let nextId = 1;
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const bcast = o => { const s = JSON.stringify(o); for (const [ws, p] of clients) if (p.reg && ws.readyState === 1) ws.send(s); };
const rnd = n => Math.random() * n | 0;
const pub = p => ({ id: p.id, nick: p.nick, avatar: p.avatar, balance: p.balance });
const emailOf = p => (p.uid || '').split(':').slice(1).join(':');

/* ---------- батлы ---------- */
const battles = new Map();
const battleList = () => ({ type: 'battles_list', battles: [...battles.values()].map(b => ({ id: b.id, hostId: b.host.id, hostNick: b.host.nick, hostAvatar: b.host.avatar, caseId: b.caseId, count: b.count, cost: b.cost })) });
function dropBattle(p) { for (const [id, b] of battles) if (b.host === p) battles.delete(id); }

/* ---------- шахматы ---------- */
const games = new Map();
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const chessList = () => ({ type: 'chess_list', games: [...games.values()].filter(g => g.state === 'wait').map(g => ({ id: g.id, hostId: g.host.id, hostNick: g.host.nick, hostAvatar: g.host.avatar, bet: g.bet })) });
function finishChess(g, winner, reason) {
  if (g.fin) return; g.fin = true;
  for (const p of [g.host, g.guest]) if (p) { send(p.ws, { type: 'chess_finished', winner, reason: reason || 'normal' }); p.chess = null; }
  games.delete(g.id); bcast(chessList());
}
function leaveChess(p) {
  const g = p.chess && games.get(p.chess); if (!g) return;
  if (g.state === 'wait') { games.delete(g.id); p.chess = null; bcast(chessList()); return; }
  finishChess(g, g.host === p ? 'b' : 'w', 'disconnect');
}

/* ======================= ХОРРОР: лабиринт + Жнец ======================= */
const rooms = new Map();
const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rcode = () => { let c; do { c = Array.from({ length: 4 }, () => CH[rnd(CH.length)]).join(''); } while (rooms.has(c)); return c; };
const rpl = r => [...r.pl.values()].map(p => ({ id: p.id, nick: p.nick, avatar: p.avatar, idx: p.idx }));
const rbcast = (r, o) => { for (const p of r.pl.values()) send(p.ws, o); };

function bfs(g, sx, sy) {
  const n = g.length, d = Array.from({ length: n }, () => Array(n).fill(-1)), q = [[sx, sy]]; d[sy][sx] = 0;
  for (let i = 0; i < q.length; i++) { const [x, y] = q[i]; for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + a, Y = y + b; if (X >= 0 && Y >= 0 && X < n && Y < n && !g[Y][X] && d[Y][X] < 0) { d[Y][X] = d[y][x] + 1; q.push([X, Y]); } } }
  return d;
}
function pathTo(g, x0, y0, x1, y1) {
  const n = g.length, prev = Array.from({ length: n }, () => Array(n).fill(null)), q = [[x0, y0]]; prev[y0][x0] = [-1, -1];
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i]; if (x === x1 && y === y1) break;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + a, Y = y + b; if (X >= 0 && Y >= 0 && X < n && Y < n && !g[Y][X] && !prev[Y][X]) { prev[Y][X] = [x, y]; q.push([X, Y]); } }
  }
  if (!prev[y1][x1]) return [];
  const out = []; let c = [x1, y1]; while (c[0] !== x0 || c[1] !== y0) { out.push([c[0] + .5, c[1] + .5]); c = prev[c[1]][c[0]]; }
  return out.reverse();
}
function genMaze(n) {
  const g = Array.from({ length: n }, () => Array(n).fill(1)), st = [[1, 1]]; g[1][1] = 0;
  while (st.length) {
    const [x, y] = st[st.length - 1];
    const d = [[2, 0], [-2, 0], [0, 2], [0, -2]].filter(([a, b]) => { const X = x + a, Y = y + b; return X > 0 && Y > 0 && X < n - 1 && Y < n - 1 && g[Y][X]; });
    if (!d.length) { st.pop(); continue; }
    const [a, b] = d[rnd(d.length)]; g[y + b / 2][x + a / 2] = 0; g[y + b][x + a] = 0; st.push([x + a, y + b]);
  }
  for (let k = 0; k < n * 2; k++) { // петли, чтобы не было только тупиков
    const x = 1 + rnd(n - 2), y = 1 + rnd(n - 2);
    if (g[y][x] && ((x % 2 === 0 && y % 2 === 1) || (x % 2 === 1 && y % 2 === 0))) g[y][x] = 0;
  }
  for (let k = 0; k < 4; k++) { // комнаты 3x3
    const x0 = 3 + 2 * rnd((n - 7) / 2), y0 = 3 + 2 * rnd((n - 7) / 2); if (x0 < 6 && y0 < 6) continue;
    for (let y = y0; y < y0 + 3; y++) for (let x = x0; x < x0 + 3; x++) g[y][x] = 0;
  }
  const dist = bfs(g, 1, 1), ex = n - 2, dex = bfs(g, ex, ex), odd = [];
  for (let y = 1; y < n - 1; y += 2) for (let x = 1; x < n - 1; x += 2) odd.push([x, y]);
  const far = odd.filter(([x, y]) => dist[y][x] >= 12 && dex[y][x] >= 6), sig = [];
  for (let tries = 0; tries < 300 && sig.length < 3; tries++) {
    const c = far[rnd(far.length)]; if (c && sig.every(s => Math.abs(s[0] - c[0]) + Math.abs(s[1] - c[1]) >= 8)) sig.push(c);
  }
  while (sig.length < 3) sig.push(odd[rnd(odd.length)]);
  const mons = odd.filter(([x, y]) => dist[y][x] >= 16), mc = mons.length ? mons[rnd(mons.length)] : odd[odd.length - 1];
  return { grid: g, sig: sig.map(c => ({ x: c[0] + .5, y: c[1] + .5 })), exit: { x: ex + .5, y: ex + .5 }, mon: { x: mc[0] + .5, y: mc[1] + .5 } };
}
function los(g, x0, y0, x1, y1) {
  const d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / .15);
  for (let i = 1; i < n; i++) { const t = i / n, gy = g[(y0 + (y1 - y0) * t) | 0]; if (!gy || gy[(x0 + (x1 - x0) * t) | 0]) return false; }
  return true;
}
const NOISE_R = [1.2, 3.6, 8.5];      // радиус слышимости: стоим / идём / бежим
const SIGHT_R = [4, 9, 12];           // дальность зрения по "заметности" цели
function monster(r, live, dt, now) {
  const M = r.mon, g = r.grid;
  if (M.stun > 0) { M.stun -= dt; return; }
  const seals = r.taken.reduce((a, b) => a + b, 0), spd = [1.15, 1.9, 2.1 + .25 * seals][M.s];
  const fx = Math.cos(M.a), fy = Math.sin(M.a); let seen = null, sd = 99;
  for (const p of live) { // ЗРЕНИЕ: только конус впереди + прямая видимость
    const dx = p.x - M.x, dy = p.y - M.y, d = Math.hypot(dx, dy), rng = SIGHT_R[p.mode] * (p.fl ? 1.2 : 1);
    if (d > rng || d >= sd) continue;
    if (!(d < 1.8 || (dx * fx + dy * fy) / d > .5)) continue;
    if (!los(g, M.x, M.y, p.x, p.y)) continue;
    sd = d; seen = p;
  }
  if (seen) { M.s = 2; M.tx = seen.x; M.ty = seen.y; M.lost = 0; M.look = 0; }
  else {
    if (M.s === 2) { M.lost += dt; if (M.lost > 4) { M.s = 1; M.look = 0; } }
    if (M.s !== 2) { // СЛУХ: шум игроков и подобранных печатей (за стенами слышно хуже)
      let hear = null, hd = 99;
      const src = live.map(p => ({ x: p.x, y: p.y, r: NOISE_R[p.mode] })).concat(r.noise.filter(n => n.t > now));
      for (const s of src) { const d = Math.hypot(s.x - M.x, s.y - M.y), rr = los(g, M.x, M.y, s.x, s.y) ? s.r : s.r * .6; if (d <= rr && d < hd) { hd = d; hear = s; } }
      if (hear) { M.s = 1; M.tx = hear.x; M.ty = hear.y; M.look = 0; }
    }
  }
  if (M.tx == null) { // патруль: случайная клетка подальше
    for (let i = 0; i < 20; i++) { const x = 1 + rnd(r.n - 2), y = 1 + rnd(r.n - 2); if (!g[y][x] && Math.hypot(x - M.x, y - M.y) > 6) { M.tx = x + .5; M.ty = y + .5; M.path = []; break; } }
  }
  if (M.tx != null) {
    let wx = null, wy = null;
    const direct = M.s === 2 && seen;
    if (direct) { wx = M.tx; wy = M.ty; M.path = []; }
    else {
      M.pt -= dt;
      if (M.pt <= 0 || !M.path.length) { M.path = pathTo(g, M.x | 0, M.y | 0, M.tx | 0, M.ty | 0); M.pt = .35; }
      while (M.path.length && Math.hypot(M.path[0][0] - M.x, M.path[0][1] - M.y) < .3) M.path.shift();
      if (M.path.length) { wx = M.path[0][0]; wy = M.path[0][1]; }
    }
    if (wx != null) { const a = Math.atan2(wy - M.y, wx - M.x), st = Math.min(spd * dt, Math.hypot(wx - M.x, wy - M.y) + .01); M.a = a; M.x += Math.cos(a) * st; M.y += Math.sin(a) * st; }
    else { // дошёл до цели
      if (M.s === 1) { M.look += dt; M.a += dt * 1.4; if (M.look > 3) { M.s = 0; M.tx = null; } }
      else if (M.s === 2 && !seen) { M.s = 1; M.look = 0; } else M.tx = null;
    }
  }
  for (const p of live) if (Math.hypot(p.x - M.x, p.y - M.y) < .8) { p.alive = false; M.stun = 2.2; M.s = 0; M.tx = null; }
}
function hStart(r) {
  const n = 23, m = genMaze(n);
  Object.assign(r, { state: 'play', n, grid: m.grid, sig: m.sig, exit: m.exit, taken: [0, 0, 0], open: false, noise: [], last: Date.now(), startAt: Date.now() + 22000,
    mon: { x: m.mon.x, y: m.mon.y, a: 0, s: 0, tx: null, ty: null, path: [], pt: 0, look: 0, lost: 0, stun: 0 } });
  for (const p of r.pl.values()) Object.assign(p, { x: 1.5 + (Math.random() - .5) * .3, y: 1.5 + (Math.random() - .5) * .3, yaw: 0, mode: 0, fl: 1, alive: true, esc: false, lt: Date.now() });
  rbcast(r, { type: 'h_start', grid: r.grid, n, sig: r.sig, exit: r.exit, players: rpl(r), delay: 22000 });
  r.timer = setInterval(() => hTick(r), 66);
}
function hTick(r) {
  const now = Date.now(), dt = Math.min(.2, (now - r.last) / 1000); r.last = now;
  const ps = [...r.pl.values()], live = ps.filter(p => p.alive && !p.esc);
  r.noise = r.noise.filter(n => n.t > now);
  if (now >= r.startAt && live.length) monster(r, live, dt, now);
  if (r.open) for (const p of live) if (p.alive && Math.hypot(p.x - r.exit.x, p.y - r.exit.y) < 1.1) { p.esc = true; send(p.ws, { type: 'h_escaped' }); }
  if (!ps.some(p => p.alive && !p.esc)) return hEnd(r);
  const f = v => +v.toFixed(2);
  rbcast(r, { type: 'h_state', p: ps.map(p => [p.id, f(p.x), f(p.y), p.alive ? 1 : 0, f(p.yaw), p.mode, p.esc ? 1 : 0]), m: [f(r.mon.x), f(r.mon.y), f(r.mon.a), r.mon.s], s: r.taken, open: r.open ? 1 : 0 });
}
function hEnd(r) {
  clearInterval(r.timer); r.state = 'lobby';
  const ps = [...r.pl.values()], escaped = ps.filter(p => p.esc).map(p => p.id);
  for (const p of ps) send(p.ws, { type: 'h_end', win: !!p.esc, escaped, msg: p.esc ? '🏆 Ты сбежал из особняка!' : escaped.length ? 'Друзья сбежали, а тебя забрал Жнец…' : '☠ Особняк забрал всех.' });
  rbcast(r, { type: 'h_room', code: r.code, host: r.host, players: rpl(r) });
}
function hRemove(p) {
  const r = p.room && rooms.get(p.room); if (!r) return; p.room = null; r.pl.delete(p.id);
  if (!r.pl.size) { clearInterval(r.timer); rooms.delete(r.code); return; }
  if (r.host === p.id) r.host = [...r.pl.keys()][0];
  if (r.state === 'play') { if (![...r.pl.values()].some(q => q.alive && !q.esc)) hEnd(r); }
  else rbcast(r, { type: 'h_room', code: r.code, host: r.host, players: rpl(r) });
}
function hMsg(ws, p, m) {
  const r = p.room && rooms.get(p.room);
  switch (m.type) {
    case 'h_create': { if (r) hRemove(p); const code = rcode(), room = { code, host: p.id, pl: new Map(), state: 'lobby' }; rooms.set(code, room); room.pl.set(p.id, Object.assign(p, { ws, idx: 0, room: code })); send(ws, { type: 'h_room', code, host: p.id, players: rpl(room) }); break; }
    case 'h_join': {
      const room = rooms.get(String(m.code || '').toUpperCase().slice(0, 4));
      if (!room) return send(ws, { type: 'h_err', msg: 'Комната не найдена' });
      if (room.state === 'play') return send(ws, { type: 'h_err', msg: 'Игра уже идёт' });
      if (room.pl.size >= 4) return send(ws, { type: 'h_err', msg: 'Комната заполнена' });
      if (r) hRemove(p);
      const used = new Set([...room.pl.values()].map(q => q.idx)); let idx = 0; while (used.has(idx)) idx++;
      p.idx = idx; p.room = room.code; room.pl.set(p.id, p); rbcast(room, { type: 'h_room', code: room.code, host: room.host, players: rpl(room) }); break;
    }
    case 'h_leave': hRemove(p); break;
    case 'h_start': if (r && r.state === 'lobby' && r.host === p.id) hStart(r); break;
    case 'h_pos': {
      if (!r || r.state !== 'play' || !p.alive || p.esc) break;
      const x = +m.x, y = +m.y; if (!isFinite(x) || !isFinite(y)) break;
      const row = r.grid[y | 0]; if (!row || row[x | 0] !== 0) break;
      const now = Date.now(), dt = (now - p.lt) / 1000;
      if (Math.hypot(x - p.x, y - p.y) <= 3.8 * Math.max(dt, .05) + .5) { p.x = x; p.y = y; p.lt = now; }
      p.yaw = +m.yaw || 0; p.mode = Math.max(0, Math.min(2, m.mode | 0)); p.fl = m.fl ? 1 : 0; break;
    }
    case 'h_pick': {
      if (!r || r.state !== 'play' || !p.alive || p.esc) break;
      const i = m.i | 0, s = r.sig[i]; if (!s || r.taken[i] || Math.hypot(p.x - s.x, p.y - s.y) > 1.4) break;
      r.taken[i] = 1; r.noise.push({ x: s.x, y: s.y, r: 9, t: Date.now() + 1500 }); // печать "кричит" — Жнец слышит
      if (r.taken.every(Boolean)) r.open = true; break;
    }
  }
}

/* ======================= ОБЩИЕ СООБЩЕНИЯ ======================= */
wss.on('connection', ws => {
  const p = { id: 'p' + (nextId++), ws, nick: 'Игрок', avatar: '👤', balance: 0, uid: '', reg: false, chess: null, room: null };
  clients.set(ws, p); ws.isAlive = true; ws.on('pong', () => ws.isAlive = true);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, p, m); } catch (e) { console.error('handle', m && m.type, e); }
  });
  ws.on('close', () => {
    leaveChess(p); dropBattle(p); hRemove(p); clients.delete(ws);
    if (p.reg) { bcast({ type: 'online_count', count: onlineCount() }); bcast(battleList()); }
  });
});
const onlineCount = () => [...clients.values()].filter(p => p.reg).length;

function handle(ws, p, m) {
  if (m.type && m.type.startsWith('h_')) return hMsg(ws, p, m);
  switch (m.type) {
    /* --- аккаунты (отдельное короткое соединение с клиента) --- */
    case 'auth_register': {
      const email = String(m.email || '').trim().toLowerCase(), pass = String(m.pass || '');
      if (!email || email.length > 80 || pass.length < 3) return send(ws, { type: 'auth_err', msg: 'Введите почту и пароль (от 3 символов)' });
      if (users[email]) return send(ws, { type: 'auth_err', msg: 'Эта почта уже зарегистрирована' });
      const salt = crypto.randomBytes(8).toString('hex'), { pass: _x, ...data } = m.data || {};
      users[email] = { salt, h: hash(pass, salt), data: { ...data, email } }; dirty = true;
      return send(ws, { type: 'auth_ok', data: users[email].data });
    }
    case 'auth_login': {
      const email = String(m.email || '').trim().toLowerCase(), u = users[email];
      if (!u) return send(ws, { type: 'auth_err', msg: 'Аккаунт не найден' });
      if (u.h !== hash(String(m.pass || ''), u.salt)) return send(ws, { type: 'auth_err', msg: 'Неверный пароль' });
      return send(ws, { type: 'auth_ok', data: u.data });
    }
    case 'save_data': {
      const u = users[String(m.email || '').toLowerCase()];
      if (u && u.h === hash(String(m.pass || ''), u.salt) && m.data) { const { pass: _x, ...data } = m.data; u.data = data; dirty = true; }
      break;
    }
    /* --- игрок онлайн --- */
    case 'register': {
      const first = !p.reg;
      Object.assign(p, { reg: true, uid: String(m.uid || ''), nick: String(m.nick || 'Игрок').slice(0, 20), avatar: String(m.avatar || '👤').slice(0, 8), balance: Number(m.balance) || 0 });
      if (first) send(ws, { type: 'welcome', id: p.id });
      bcast({ type: 'online_count', count: onlineCount() });
      send(ws, chessList()); send(ws, battleList()); break;
    }
    case 'update_balance': {
      p.balance = Number(m.balance) || 0;
      const u = users[emailOf(p)]; if (u && u.data) { u.data.balance = p.balance; dirty = true; }
      break;
    }
    case 'get_players': send(ws, { type: 'players_list', players: [...clients.values()].filter(q => q.reg).map(pub) }); break;
    case 'get_leaderboard': send(ws, { type: 'leaderboard', list: Object.values(users).map(u => u.data || {}).filter(d => d.nick).sort((a, b) => (b.balance || 0) - (a.balance || 0)).slice(0, 20).map(d => ({ nick: d.nick, avatar: d.avatar, balance: d.balance || 0 })) }); break;

    /* --- батлы --- */
    case 'get_battles': send(ws, battleList()); break;
    case 'create_battle': {
      if (!p.reg || p.chess || [...battles.values()].some(b => b.host === p)) break;
      const count = [1, 2, 3, 5].includes(m.count) ? m.count : 1, id = 'b' + (nextId++);
      battles.set(id, { id, host: p, caseId: String(m.caseId), count, cost: Math.max(0, Number(m.cost) || 0) });
      send(ws, { type: 'battle_created' }); bcast(battleList()); break;
    }
    case 'cancel_battle': dropBattle(p); bcast(battleList()); break;
    case 'join_battle': {
      const b = battles.get(m.battleId); if (!b || b.host === p) break;
      battles.delete(b.id);
      const o = { type: 'battle_start', caseId: b.caseId, count: b.count, cost: b.cost, seed: crypto.randomBytes(4).readUInt32BE(0), host: pub(b.host), guest: pub(p) };
      send(b.host.ws, o); send(ws, o); bcast(battleList()); break;
    }

    /* --- шахматы --- */
    case 'get_chess_list': send(ws, chessList()); break;
    case 'create_chess': {
      const bet = Math.floor(Number(m.bet)); if (!p.reg || p.chess || !(bet >= 10)) break;
      const id = 'c' + (nextId++); games.set(id, { id, host: p, guest: null, bet, state: 'wait', fin: false }); p.chess = id;
      send(ws, { type: 'chess_created' }); bcast(chessList()); break;
    }
    case 'cancel_chess': leaveChess(p); break;
    case 'join_chess': {
      const g = games.get(m.gameId); if (!g || g.state !== 'wait' || g.host === p || p.chess) break;
      g.guest = p; g.state = 'play'; p.chess = g.id;
      send(g.host.ws, { type: 'chess_start', gameId: g.id, bet: g.bet, color: 'w', fen: START_FEN });
      send(ws, { type: 'chess_start', gameId: g.id, bet: g.bet, color: 'b', fen: START_FEN }); bcast(chessList()); break;
    }
    case 'chess_move': {
      const g = games.get(m.gameId); if (!g || g.state !== 'play' || (g.host !== p && g.guest !== p)) break;
      send(g.host === p ? g.guest.ws : g.host.ws, { type: 'chess_update', fen: String(m.fen), turn: m.turn }); break;
    }
    case 'chess_end': {
      const g = games.get(m.gameId); if (!g || g.state !== 'play' || (g.host !== p && g.guest !== p)) break;
      finishChess(g, ['w', 'b', 'draw'].includes(m.winner) ? m.winner : 'draw'); break;
    }
  }
}

/* пинг, чтобы Render/прокси не рвали соединения */
setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} } }, 25000);
server.listen(PORT, () => console.log('Dark Gramm server on :' + PORT));
