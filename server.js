const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Dark Gramm Online Server is Running');
});

const wss = new WebSocket.Server({ server });

let players = {};
let caseBattles = {};
let chessGames = {}; // Хранилище шахматных игр

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substring(2, 9);
  ws.send(JSON.stringify({ type: 'welcome', id: ws.id }));

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }

    switch (data.type) {
      case 'register':
        players[ws.id] = { id: ws.id, nick: data.nick, avatar: data.avatar, balance: data.balance || 0, ws: ws };
        broadcastOnlineCount();
        broadcastBattles();
        broadcastPlayers();
        broadcastChessList();
        break;

      case 'update_balance':
        if (players[ws.id]) {
          players[ws.id].balance = data.balance;
          broadcastPlayers();
        }
        break;

      // --- БАТЛЫ ---
      case 'create_battle': {
        if (!players[ws.id]) return;
        const battleId = 'b_' + Date.now();
        caseBattles[battleId] = {
          id: battleId, host: ws.id, hostNick: players[ws.id].nick, hostAvatar: players[ws.id].avatar,
          price: data.price, caseCount: data.count || 1, status: 'waiting'
        };
        broadcastBattles();
        break;
      }

      case 'join_battle': {
        const battle = caseBattles[data.battleId];
        if (!battle || battle.status !== 'waiting' || battle.host === ws.id) return;
        const host = players[battle.host];
        const guest = players[ws.id];
        if (!host || !guest || host.balance < battle.price || guest.balance < battle.price) return;

        battle.status = 'playing';
        host.balance -= battle.price;
        guest.balance -= battle.price;

        host.ws.send(JSON.stringify({ type: 'battle_start', enemy: { nick: guest.nick, avatar: guest.avatar }, isHost: true }));
        guest.ws.send(JSON.stringify({ type: 'battle_start', enemy: { nick: host.nick, avatar: host.avatar }, isHost: false }));

        setTimeout(() => {
          const hostScore = Math.floor(Math.random() * 5000) + battle.price;
          const guestScore = Math.floor(Math.random() * 5000) + battle.price;
          let winnerId = hostScore >= guestScore ? host.id : guest.id;
          const winner = winnerId === host.id ? host : guest;
          winner.balance += battle.price * 2;

          if (host.ws.readyState === WebSocket.OPEN) host.ws.send(JSON.stringify({ type: 'battle_result', myScore: hostScore, enemyScore: guestScore, win: winnerId === host.id }));
          if (guest.ws.readyState === WebSocket.OPEN) guest.ws.send(JSON.stringify({ type: 'battle_result', myScore: guestScore, enemyScore: hostScore, win: winnerId === guest.id }));
          
          delete caseBattles[battle.id];
          broadcastBattles();
          broadcastPlayers();
        }, 4000);
        broadcastBattles();
        break;
      }

      // --- ШАХМАТЫ ---
      case 'create_chess': {
        if (!players[ws.id]) return;
        if (players[ws.id].balance < data.bet) {
          ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно монет для ставки' }));
          return;
        }
        const gameId = 'c_' + Date.now();
        chessGames[gameId] = {
          id: gameId,
          host: ws.id,
          hostNick: players[ws.id].nick,
          hostAvatar: players[ws.id].avatar,
          bet: data.bet,
          status: 'waiting',
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', // Начальная расстановка
          turn: 'w'
        };
        broadcastChessList();
        break;
      }

      case 'join_chess': {
        const game = chessGames[data.gameId];
        if (!game || game.status !== 'waiting' || game.host === ws.id) return;
        const host = players[game.host];
        const guest = players[ws.id];
        if (!host || !guest || host.balance < game.bet || guest.balance < game.bet) {
          ws.send(JSON.stringify({ type: 'error', message: 'У кого-то не хватает монет' }));
          return;
        }

        game.status = 'playing';
        game.guest = ws.id;
        game.guestNick = guest.nick;
        game.guestAvatar = guest.avatar;
        
        host.balance -= game.bet;
        guest.balance -= game.bet;

        // Стартуем игру (хост играет белыми, гость черными)
        host.ws.send(JSON.stringify({ type: 'chess_start', gameId: game.id, color: 'w', enemy: { nick: guest.nick, avatar: guest.avatar }, fen: game.fen }));
        guest.ws.send(JSON.stringify({ type: 'chess_start', gameId: game.id, color: 'b', enemy: { nick: host.nick, avatar: host.avatar }, fen: game.fen }));
        
        broadcastChessList();
        broadcastPlayers();
        break;
      }

      case 'chess_move': {
        const game = chessGames[data.gameId];
        if (!game || game.status !== 'playing') return;
        // Обновляем состояние доски
        game.fen = data.fen;
        game.turn = data.turn;
        
        // Отправляем ход сопернику
        const opponentId = ws.id === game.host ? game.guest : game.host;
        const opponent = players[opponentId];
        if (opponent && opponent.ws.readyState === WebSocket.OPEN) {
          opponent.ws.send(JSON.stringify({ type: 'chess_update', fen: game.fen, turn: game.turn }));
        }
        break;
      }

      case 'chess_end': {
        const game = chessGames[data.gameId];
        if (!game || game.status !== 'playing') return;
        game.status = 'finished';
        
        const host = players[game.host];
        const guest = players[game.guest];
        
        // data.winner = 'w' (белые) или 'b' (черные) или 'draw'
        let winnerPlayer = null;
        if (data.winner === 'w') winnerPlayer = host;
        if (data.winner === 'b') winnerPlayer = guest;
        
        if (winnerPlayer) {
          winnerPlayer.balance += game.bet * 2; // Победитель забирает банк
        } else {
          // Ничья - возврат ставок
          if (host) host.balance += game.bet;
          if (guest) guest.balance += game.bet;
        }

        sendToAll({ type: 'chess_finished', gameId: game.id, winner: data.winner });
        delete chessGames[game.id];
        broadcastChessList();
        broadcastPlayers();
        break;
      }
    }
  });

  ws.on('close', () => {
    delete players[ws.id];
    for (const key in caseBattles) {
      if (caseBattles[key].host === ws.id && caseBattles[key].status === 'waiting') delete caseBattles[key];
    }
    for (const key in chessGames) {
      if (chessGames[key].host === ws.id && chessGames[key].status === 'waiting') delete chessGames[key];
    }
    broadcastOnlineCount();
    broadcastBattles();
    broadcastPlayers();
    broadcastChessList();
  });
});

function broadcastOnlineCount() { sendToAll({ type: 'online_count', count: Object.keys(players).length }); }
function broadcastBattles() {
  const list = Object.values(caseBattles).filter(b => b.status === 'waiting').map(b => ({ id: b.id, hostNick: b.hostNick, hostAvatar: b.hostAvatar, price: b.price, caseCount: b.caseCount }));
  sendToAll({ type: 'battles_list', battles: list });
}
function broadcastChessList() {
  const list = Object.values(chessGames).filter(c => c.status === 'waiting').map(c => ({ id: c.id, hostNick: c.hostNick, hostAvatar: c.hostAvatar, bet: c.bet }));
  sendToAll({ type: 'chess_list', games: list });
}
function broadcastPlayers() {
  const list = Object.values(players).map(p => ({ id: p.id, nick: p.nick, avatar: p.avatar, balance: p.balance })).sort((a, b) => b.balance - a.balance);
  sendToAll({ type: 'players_list', players: list });
  sendToAll({ type: 'leaderboard', list: list.slice(0, 10) });
}
function sendToAll(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('✅ Сервер запущен на порту ' + PORT));
