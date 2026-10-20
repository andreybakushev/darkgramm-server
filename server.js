// Dark Gramm server — npm i ws ; node server.js
const http = require('http'), fs = require('fs'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const FILE = process.env.DATA_FILE || './data.json';
let DB = { accounts: {} };
try { DB = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(FILE, JSON.stringify(DB), () => {}); } }, 4000);
const hash = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex');
const authOk = (email, pass) => { const a = DB.accounts[email]; return a && a.hash === hash(pass, a.salt) ? a : null; };

const server = http.createServer((q, r) => { r.writeHead(200); r.end('Dark Gramm server OK'); });
const wss = new WebSocketServer({ server });
const clients = new Map(); let nid = 1;
const chessGames = new Map(), battles = new Map(), rooms = new Map();
const S = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const byId = id => { const c = clients.get(id); return c && c.ws; };
const pub = c => ({ id: c.id, nick: c.nick, avatar: c.avatar, balance: c.balance });
const bcast = o => clients.forEach(c => S(c.ws, o));
const sendOnline = () => bcast({ type: 'online_count', count: clients.size });
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const chessList = () => [...chessGames.values()].filter(g => !g.guest).map(g => { const h = clients.get(g.host); return { id: g.id, bet: g.bet, hostId: g.host, hostNick: h ? h.nick : '?', hostAvatar: h ? h.avatar : '👤' }; });
const battleList = () => [...battles.values()].filter(b => !b.guest).map(b => { const h = clients.get(b.host); return { id: b.id, caseId: b.caseId, count: b.count, cost: b.cost, hostId: b.host, hostNick: h ? h.nick : '?', hostAvatar: h ? h.avatar : '👤' }; });
const refreshLists = () => { const c = { type: 'chess_list', games: chessList() }, b = { type: 'battles_list', battles: battleList() }; bcast(c); bcast(b); };

/* ---------- ХОРРОР ---------- */
const N = 21;
function maze() {
  const g = Array.from({ length: N }, () => Array(N).fill(1)); g[1][1] = 0; const st = [[1, 1]];
  while (st.length) {
    const [x, y] = st[st.length - 1];
    const d = [[2, 0], [-2, 0], [0, 2], [0, -2]].filter(([a, b]) => { const nx = x + a, ny = y + b; return nx > 0 && ny > 0 && nx < N - 1 && ny < N - 1 && g[ny][nx] === 1; });
    if (!d.length) { st.pop(); continue; }
    const [a, b] = d[Math.random() * d.length | 0]; g[y + b / 2][x + a / 2] = 0; g[y + b][x + a] = 0; st.push([x + a, y + b]);
  }
  for (let i = 0; i < 40; i++) { const x = 1 + (Math.random() * (N - 2) | 0), y = 1 + (Math.random() * (N - 2) | 0); g[y][x] = 0; }
  return g;
}
const roomInfo = r => ({ type: 'h_room', code: r.code, host: r.host, state: r.state, players: [...r.players.values()].map(p => ({ id: p.id, nick: p.nick, avatar: p.avatar })) });
const roomSend = (r, o) => r.players.forEach(p => S(byId(p.id), o));
function leaveRoom(id) {
  for (const r of rooms.values()) if (r.players.has(id)) {
    r.players.delete(id);
    if (!r.players.size) { clearInterval(r.timer); rooms.delete(r.code); return; }
    if (r.host === id) r.host = [...r.players.keys()][0];
    if (r.state === 'play' && ![...r.players.values()].some(p => p.alive)) endHorror(r, false, 'Все погибли. Жнец победил…');
    roomSend(r, roomInfo(r));
  }
}
function startHorror(r) {
  r.state = 'play'; r.grid = maze(); r.open = false; r.t = 0;
  const cells = []; for (let y = 1; y < N; y += 2) for (let x = 1; x < N; x += 2) if (x + y > 14 && !(x === N - 2 && y === N - 2)) cells.push([x, y]);
  r.sig = []; while (r.sig.length < 3) { const c = cells.splice(Math.random() * cells.length | 0, 1)[0]; r.sig.push({ x: c[0] + .5, y: c[1] + .5, taken: false }); }
  r.exit = { x: N - 1.5, y: N - 1.5 }; r.m = { x: N - 1.5, y: 1.5 };
  r.players.forEach(p => { p.x = 1.5; p.y = 1.5; p.alive = true; });
  roomSend(r, { type: 'h_start', grid: r.grid, n: N, sig: r.sig, exit: r.exit });
  clearInterval(r.timer); r.timer = setInterval(() => tickHorror(r), 100);
}
function endHorror(r, win, msg) { clearInterval(r.timer); r.state = 'lobby'; roomSend(r, { type: 'h_end', win, msg }); roomSend(r, roomInfo(r)); }
function tickHorror(r) {
  const dt = .1, al = [...r.players.values()].filter(p => p.alive);
  if (!al.length) return endHorror(r, false, 'Все погибли. Жнец победил…');
  // монстр: BFS к ближайшему живому
  let tgt = al[0], bd = 1e9; al.forEach(p => { const d = Math.hypot(p.x - r.m.x, p.y - r.m.y); if (d < bd) { bd = d; tgt = p; } });
  const tx = tgt.x | 0, ty = tgt.y | 0, dist = Array.from({ length: N }, () => Array(N).fill(1e9)); dist[ty][tx] = 0; const q = [[tx, ty]];
  while (q.length) { const [x, y] = q.shift(); for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + a, ny = y + b; if (r.grid[ny] && r.grid[ny][nx] === 0 && dist[ny][nx] > dist[y][x] + 1) { dist[ny][nx] = dist[y][x] + 1; q.push([nx, ny]); } } }
  const mx = r.m.x | 0, my = r.m.y | 0; let best = [mx, my];
  for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = mx + a, ny = my + b; if (dist[ny] && dist[ny][nx] < dist[best[1]][best[0]]) best = [nx, ny]; }
  const sp = (2 + r.sig.filter(s => s.taken).length * .35) * dt, bx = best[0] + .5, by = best[1] + .5, dd = Math.hypot(bx - r.m.x, by - r.m.y) || 1;
  if (bd > 0.7) { r.m.x += (bx - r.m.x) / dd * Math.min(sp, dd); r.m.y += (by - r.m.y) / dd * Math.min(sp, dd); } else { r.m.x += (tgt.x - r.m.x) * .3; r.m.y += (tgt.y - r.m.y) * .3; }
  al.forEach(p => { if (Math.hypot(p.x - r.m.x, p.y - r.m.y) < .6) p.alive = false; });
  r.open = r.sig.every(s => s.taken);
  if (r.open && [...r.players.values()].some(p => p.alive && Math.hypot(p.x - r.exit.x, p.y - r.exit.y) < .8)) return endHorror(r, true, 'Вы выбрались из особняка!');
  roomSend(r, { type: 'h_state', p: [...r.players.values()].map(p => [p.id, +p.x.toFixed(2), +p.y.toFixed(2), p.alive]), m: [+r.m.x.toFixed(2), +r.m.y.toFixed(2)], s: r.sig.map(s => s.taken), open: r.open });
}

/* ---------- СОЕДИНЕНИЯ ---------- */
wss.on('connection', ws => {
  const c = { id: 'p' + nid++, ws, nick: 'Игрок', avatar: '👤', balance: 0, uid: null, alive: true };
  clients.set(c.id, c); ws.on('pong', () => c.alive = true);
  S(ws, { type: 'welcome', id: c.id }); sendOnline();
  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    switch (d.type) {
      /* аккаунты */
      case 'auth_register': {
        const email = String(d.email || '').trim().toLowerCase();
        if (!email || !d.pass) return S(ws, { type: 'auth_err', msg: 'Введите почту и пароль' });
        if (DB.accounts[email]) return S(ws, { type: 'auth_err', msg: 'Почта уже зарегистрирована' });
        const salt = crypto.randomBytes(8).toString('hex');
        DB.accounts[email] = { salt, hash: hash(d.pass, salt), data: d.data || {} }; dirty = true;
        S(ws, { type: 'auth_ok', data: DB.accounts[email].data }); break;
      }
      case 'auth_login': {
        const a = authOk(String(d.email || '').trim().toLowerCase(), d.pass);
        S(ws, a ? { type: 'auth_ok', data: a.data } : { type: 'auth_err', msg: 'Неверная почта или пароль' }); break;
      }
      case 'save_data': {
        const email = String(d.email || '').trim().toLowerCase(), a = authOk(email, d.pass);
        if (a && JSON.stringify(d.data).length < 500000) { a.data = d.data; dirty = true; } break;
      }
      case 'register': c.nick = String(d.nick || 'Игрок').slice(0, 20); c.avatar = String(d.avatar || '👤').slice(0, 4); c.balance = +d.balance || 0; c.uid = d.uid; refreshLists(); break;
      case 'update_balance': c.balance = +d.balance || 0; break;
      case 'get_players': S(ws, { type: 'players_list', players: [...clients.values()].map(pub) }); break;
      case 'get_leaderboard': S(ws, { type: 'leaderboard', list: Object.values(DB.accounts).map(a => ({ nick: a.data.nick, avatar: a.data.avatar, balance: a.data.balance || 0 })).sort((x, y) => y.balance - x.balance).slice(0, 20) }); break;
      case 'get_chess_list': S(ws, { type: 'chess_list', games: chessList() }); break;
      case 'get_battles': S(ws, { type: 'battles_list', battles: battleList() }); break;

      /* шахматы */
      case 'create_chess': {
        for (const g of chessGames.values()) if (g.host === c.id && !g.guest) chessGames.delete(g.id);
        const bet = Math.max(10, d.bet | 0), id = 'c' + Date.now() + c.id;
        chessGames.set(id, { id, bet, host: c.id, guest: null, fen: START, done: false }); S(ws, { type: 'chess_created' }); refreshLists(); break;
      }
      case 'cancel_chess': for (const g of chessGames.values()) if (g.host === c.id && !g.guest) chessGames.delete(g.id); refreshLists(); break;
      case 'join_chess': {
        const g = chessGames.get(d.gameId); if (!g || g.guest || g.host === c.id) return S(ws, { type: 'chess_list', games: chessList() });
        g.guest = c.id; const hostWhite = Math.random() < .5; g.white = hostWhite ? g.host : g.guest;
        S(byId(g.host), { type: 'chess_start', gameId: g.id, bet: g.bet, color: hostWhite ? 'w' : 'b', fen: START });
        S(ws, { type: 'chess_start', gameId: g.id, bet: g.bet, color: hostWhite ? 'b' : 'w', fen: START }); refreshLists(); break;
      }
      case 'chess_move': {
        const g = chessGames.get(d.gameId); if (!g || g.done || (g.host !== c.id && g.guest !== c.id)) return;
        g.fen = d.fen; S(byId(g.host === c.id ? g.guest : g.host), { type: 'chess_update', fen: d.fen, turn: d.turn }); break;
      }
      case 'chess_end': {
        const g = chessGames.get(d.gameId); if (!g || g.done || (g.host !== c.id && g.guest !== c.id)) return;
        g.done = true; const o = { type: 'chess_finished', winner: d.winner, reason: d.reason };
        S(byId(g.host), o); S(byId(g.guest), o); chessGames.delete(g.id); refreshLists(); break;
      }

      /* батлы */
      case 'create_battle': {
        for (const b of battles.values()) if (b.host === c.id && !b.guest) battles.delete(b.id);
        const id = 'b' + Date.now() + c.id; battles.set(id, { id, caseId: d.caseId, count: Math.min(5, d.count | 0 || 1), cost: d.cost | 0, host: c.id, guest: null });
        S(ws, { type: 'battle_created' }); refreshLists(); break;
      }
      case 'cancel_battle': for (const b of battles.values()) if (b.host === c.id && !b.guest) battles.delete(b.id); refreshLists(); break;
      case 'join_battle': {
        const b = battles.get(d.battleId); if (!b || b.guest || b.host === c.id) return; b.guest = c.id;
        const h = clients.get(b.host), seed = Math.random() * 4e9 | 0;
        const o = { type: 'battle_start', caseId: b.caseId, count: b.count, cost: b.cost, seed, host: pub(h), guest: pub(c) };
        S(h.ws, o); S(ws, o); battles.delete(b.id); refreshLists(); break;
      }

      /* хоррор */
      case 'h_create': {
        leaveRoom(c.id); let code; do code = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(code));
        const r = { code, host: c.id, state: 'lobby', players: new Map() }; r.players.set(c.id, { id: c.id, nick: c.nick, avatar: c.avatar, alive: true, x: 1.5, y: 1.5 });
        rooms.set(code, r); S(ws, roomInfo(r)); break;
      }
      case 'h_join': {
        const r = rooms.get(String(d.code || '').toUpperCase().trim());
        if (!r) return S(ws, { type: 'h_err', msg: 'Комната не найдена' });
        if (r.state !== 'lobby') return S(ws, { type: 'h_err', msg: 'Игра уже идёт' });
        if (r.players.size >= 4) return S(ws, { type: 'h_err', msg: 'Комната полна (4/4)' });
        leaveRoom(c.id); r.players.set(c.id, { id: c.id, nick: c.nick, avatar: c.avatar, alive: true, x: 1.5, y: 1.5 }); roomSend(r, roomInfo(r)); break;
      }
      case 'h_leave': leaveRoom(c.id); break;
      case 'h_start': { const r = [...rooms.values()].find(x => x.host === c.id); if (r && r.state === 'lobby') startHorror(r); break; }
      case 'h_pos': { const r = [...rooms.values()].find(x => x.players.has(c.id)), p = r && r.players.get(c.id); if (p && p.alive && r.state === 'play') { p.x = +d.x; p.y = +d.y; } break; }
      case 'h_pick': { const r = [...rooms.values()].find(x => x.players.has(c.id)), p = r && r.players.get(c.id), s = r && r.sig && r.sig[d.i]; if (s && p && p.alive && !s.taken && Math.hypot(p.x - s.x, p.y - s.y) < 1.2) s.taken = true; break; }
    }
  });
  ws.on('close', () => {
    clients.delete(c.id); leaveRoom(c.id);
    for (const g of [...chessGames.values()]) {
      if (g.host === c.id || g.guest === c.id) {
        if (g.guest && !g.done) { const other = g.host === c.id ? g.guest : g.host, col = g.white === other ? 'w' : 'b'; S(byId(other), { type: 'chess_finished', winner: col, reason: 'disconnect' }); }
        chessGames.delete(g.id);
      }
    }
    for (const b of [...battles.values()]) if (b.host === c.id) battles.delete(b.id);
    sendOnline(); refreshLists();
  });
});
setInterval(() => wss.clients.forEach(w => { const c = [...clients.values()].find(x => x.ws === w); if (c && !c.alive) return w.terminate(); if (c) c.alive = false; w.ping(); }), 25000);
server.listen(process.env.PORT || 3000, () => console.log('Dark Gramm server running'));
