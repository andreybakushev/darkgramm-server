const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Dark Gramm Server — Online');
});

const wss = new WebSocket.Server({ server });

// Хранилище (в памяти сервера, пока он не перезагрузится)
let players = {};       // Все, кто когда-либо заходил
let onlineSockets = {}; // Те, кто сейчас сидит в игре (id сокета -> данные)
let chessGames = {};
let caseBattles = {};

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substring(2, 9);
  ws.send(JSON.stringify({ type: 'welcome', id: ws.id }));

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }

    switch (data.type) {
      case 'register':
        // Если игрок уже есть в базе (по uid), обновляем его
        const uid = data.uid || ws.id;
        players[uid] = { 
          id: ws.id, uid: uid, nick: data.nick || 'Игрок', 
          avatar: data.avatar || '👤', balance: data.balance || 0 
        };
        onlineSockets[ws.id] = uid;
        broadcastOnlineCount();
        broadcastPlayers(); // Обновляем таблицу
        broadcastBattles();
        broadcastChessList();
        break;

      case 'update_balance':
        const myUid = onlineSockets[ws.id];
        if (myUid && players[myUid]) {
          players[myUid].balance = data.balance;
          broadcastPlayers();
          broadcastLeaderboard();
        }
        break;

      case 'get_players':
        sendPlayers(ws);
        break;

      case 'get_leaderboard':
        sendLeaderboard(ws);
        break;

      case 'get_battles':
        sendBattles(ws);
        break;

      case 'get_chess_list':
        sendChessList(ws);
        break;

      // === КЕЙС БАТЛЫ ===
      case 'create_battle':
        const battleId = 'b_' + Date.now();
        const myPlayer = players[onlineSockets[ws.id]];
        if (!myPlayer || myPlayer.balance < data.cost) {
          ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно монет' })); return;
        }
        myPlayer.balance -= data.cost;
        updatePlayerBalance(ws.id, myPlayer.balance);
        caseBattles[battleId] = {
          id: battleId, hostId: ws.id, hostNick: myPlayer.nick, hostAvatar: myPlayer.avatar,
          caseId: data.caseId, count: data.count, cost: data.cost, status: 'waiting'
        };
        broadcastBattles();
        ws.send(JSON.stringify({ type: 'battle_created' }));
        break;

      case 'join_battle':
        const b = caseBattles[data.battleId];
        if (!b || b.status !== 'waiting') return;
        const guestPlayer = players[onlineSockets[ws.id]];
        if (!guestPlayer || guestPlayer.balance < b.cost) {
          ws.send(JSON.stringify({ type: 'error', message: 'Мало монет' })); return;
        }
        guestPlayer.balance -= b.cost;
        updatePlayerBalance(ws.id, guestPlayer.balance);
        b.status = 'playing';
        
        // Отправляем старт батла обоим
        wss.clients.forEach(c => {
          if (c.id === b.hostId || c.id === ws.id) {
            c.send(JSON.stringify({
              type: 'battle_start', caseId: b.caseId, count: b.count, cost: b.cost, seed: Date.now(),
              host: { id: b.hostId, nick: b.hostNick, avatar: b.hostAvatar },
              guest: { id: ws.id, nick: guestPlayer.nick, avatar: guestPlayer.avatar }
            }));
          }
        });
        broadcastBattles();
        break;

      // === ШАХМАТЫ ===
      case 'create_chess':
        const player = players[onlineSockets[ws.id]];
        if (!player || player.balance < data.bet) {
          ws.send(JSON.stringify({ type: 'error', message: 'Мало монет' })); return;
        }
        const chessId = 'c_' + Date.now();
        chessGames[chessId] = {
          id: chessId, hostId: ws.id, hostNick: player.nick, hostAvatar: player.avatar,
          bet: data.bet, status: 'waiting', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
        };
        broadcastChessList();
        ws.send(JSON.stringify({ type: 'chess_created' }));
        break;

      case 'join_chess':
        const cg = chessGames[data.gameId];
        if (!cg || cg.status !== 'waiting') return;
        const gGuest = players[onlineSockets[ws.id]];
        const gHost = players[onlineSockets[cg.hostId]];
        if (!gGuest || !gHost || gGuest.balance < cg.bet || gHost.balance < cg.bet) return;

        cg.status = 'playing';
        gHost.balance -= cg.bet; gGuest.balance -= cg.bet;
        updatePlayerBalance(cg.hostId, gHost.balance);
        updatePlayerBalance(ws.id, gGuest.balance);

        const startHost = { type: 'chess_start', gameId: cg.id, color: 'w', fen: cg.fen, bet: cg.bet };
        const startGuest = { type: 'chess_start', gameId: cg.id, color: 'b', fen: cg.fen, bet: cg.bet };

        wss.clients.forEach(c => {
          if (c.id === cg.hostId) c.send(JSON.stringify(startHost));
          if (c.id === ws.id) c.send(JSON.stringify(startGuest));
        });
        broadcastChessList();
        break;

      case 'chess_move':
        const cgMove = chessGames[data.gameId];
        if (!cgMove) return;
        cgMove.fen = data.fen; cgMove.turn = data.turn;
        wss.clients.forEach(c => {
          if (c.id !== ws.id && (c.id === cgMove.hostId || c.id === cgMove.guestId)) {
            c.send(JSON.stringify({ type: 'chess_update', fen: data.fen, turn: data.turn }));
          }
        });
        break;

      case 'chess_end':
        const cgEnd = chessGames[data.gameId];
        if (!cgEnd) return;
        cgEnd.status = 'finished';
        const hP = players[onlineSockets[cgEnd.hostId]];
        const gP = players[onlineSockets[cgEnd.guestId]];
        let winnerId = null;
        if (data.winner === 'w') winnerId = cgEnd.hostId;
        if (data.winner === 'b') winnerId = cgEnd.guestId;
        
        if (winnerId) {
          const wPlayer = players[onlineSockets[winnerId]];
          wPlayer.balance += cgEnd.bet * 2;
          updatePlayerBalance(winnerId, wPlayer.balance);
        } else {
          if (hP) { hP.balance += cgEnd.bet; updatePlayerBalance(cgEnd.hostId, hP.balance); }
          if (gP) { gP.balance += cgEnd.bet; updatePlayerBalance(cgEnd.guestId, gP.balance); }
        }
        
        wss.clients.forEach(c => {
          if (c.id === cgEnd.hostId || c.id === cgEnd.guestId) {
            c.send(JSON.stringify({ type: 'chess_finished', winner: data.winner }));
          }
        });
        delete chessGames[cgEnd.id];
        broadcastChessList();
        break;
    }
  });

  ws.on('close', () => {
    const uid = onlineSockets[ws.id];
    delete onlineSockets[ws.id];
    // Отмена батлов и шахмат, если хост вышел
    for (let k in caseBattles) { if (caseBattles[k].hostId === ws.id && caseBattles[k].status === 'waiting') delete caseBattles[k]; }
    for (let k in chessGames) { if (chessGames[k].hostId === ws.id && chessGames[k].status === 'waiting') delete chessGames[k]; }
    broadcastOnlineCount();
    broadcastPlayers();
    broadcastBattles();
    broadcastChessList();
  });
});

function updatePlayerBalance(socketId, balance) {
  const uid = onlineSockets[socketId];
  if (uid && players[uid]) {
    players[uid].balance = balance;
    broadcastPlayers();
    broadcastLeaderboard();
  }
}

function sendPlayers(ws) {
  const list = Object.values(players).map(p => ({
    id: p.id, uid: p.uid, nick: p.nick, avatar: p.avatar, balance: p.balance,
    isOnline: Object.values(onlineSockets).includes(p.uid)
  })).sort((a, b) => b.balance - a.balance);
  ws.send(JSON.stringify({ type: 'players_list', players: list }));
}

function sendLeaderboard(ws) {
  const list = Object.values(players).map(p => ({ nick: p.nick, avatar: p.avatar, balance: p.balance })).sort((a, b) => b.balance - a.balance).slice(0, 10);
  ws.send(JSON.stringify({ type: 'leaderboard', list }));
}

function sendBattles(ws) {
  const list = Object.values(caseBattles).filter(b => b.status === 'waiting').map(b => ({
    id: b.id, hostId: b.hostId, hostNick: b.hostNick, hostAvatar: b.hostAvatar,
    caseId: b.caseId, count: b.count, cost: b.cost
  }));
  ws.send(JSON.stringify({ type: 'battles_list', battles: list }));
}

function sendChessList(ws) {
  const list = Object.values(chessGames).filter(c => c.status === 'waiting').map(c => ({
    id: c.id, hostId: c.hostId, hostNick: c.hostNick, hostAvatar: c.hostAvatar, bet: c.bet
  }));
  ws.send(JSON.stringify({ type: 'chess_list', games: list }));
}

function broadcastOnlineCount() { sendToAll({ type: 'online_count', count: Object.keys(onlineSockets).length }); }
function broadcastPlayers() { sendToAll({ type: 'players_list', players: Object.values(players).map(p => ({ id: p.id, uid: p.uid, nick: p.nick, avatar: p.avatar, balance: p.balance, isOnline: Object.values(onlineSockets).includes(p.uid) })).sort((a, b) => b.balance - a.balance) }); }
function broadcastLeaderboard() { sendToAll({ type: 'leaderboard', list: Object.values(players).map(p => ({ nick: p.nick, avatar: p.avatar, balance: p.balance })).sort((a, b) => b.balance - a.balance).slice(0, 10) }); }
function broadcastBattles() { sendToAll({ type: 'battles_list', battles: Object.values(caseBattles).filter(b => b.status === 'waiting').map(b => ({ id: b.id, hostId: b.hostId, hostNick: b.hostNick, hostAvatar: b.hostAvatar, caseId: b.caseId, count: b.count, cost: b.cost })) }); }
function broadcastChessList() { sendToAll({ type: 'chess_list', games: Object.values(chessGames).filter(c => c.status === 'waiting').map(c => ({ id: c.id, hostId: c.hostId, hostNick: c.hostNick, hostAvatar: c.hostAvatar, bet: c.bet })) }); }

function sendToAll(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('✅ Сервер запущен на ' + PORT));
