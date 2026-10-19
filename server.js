const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Dark Gramm Online Server is Running');
});

const wss = new WebSocket.Server({ server });

let players = {};
let coinflipQueue = [];
let caseBattles = {};

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substring(2, 9);
  ws.send(JSON.stringify({ type: 'welcome', id: ws.id }));

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }

    switch (data.type) {
      case 'register':
        players[ws.id] = { 
          id: ws.id, 
          nick: data.nick, 
          avatar: data.avatar, 
          balance: data.balance || 0, 
          ws: ws 
        };
        broadcastOnlineCount();
        broadcastBattles();
        broadcastPlayers(); // Отправляем обновленный список игроков
        break;

      case 'update_balance':
        if (players[ws.id]) {
          players[ws.id].balance = data.balance;
          broadcastPlayers(); // Обновляем таблицу лидеров при изменении баланса
        }
        break;

      case 'get_players':
        // Если клиент запрашивает список игроков (при открытии вкладки)
        broadcastPlayers();
        break;

      case 'join_coinflip': {
        if (!players[ws.id]) return;
        if (players[ws.id].balance < data.bet) {
          ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно монет' }));
          return;
        }

        if (coinflipQueue.length > 0) {
          const opponentId = coinflipQueue.shift();
          const opponent = players[opponentId];
          const challenger = players[ws.id];

          if (opponent && challenger && opponent.ws.readyState === WebSocket.OPEN) {
            const bet = Math.min(data.bet, opponent.balance);
            if (opponent.balance < bet || challenger.balance < bet) {
              ws.send(JSON.stringify({ type: 'error', message: 'У противника мало монет' }));
              return;
            }

            opponent.balance -= bet;
            challenger.balance -= bet;

            const result = Math.random() < 0.5 ? 'heads' : 'tails';
            const winnerId = result === 'heads' ? challenger.id : opponent.id;
            const winner = result === 'heads' ? challenger : opponent;
            winner.balance += bet * 2;

            opponent.ws.send(JSON.stringify({
              type: 'coinflip_result', opponent: challenger.nick, bet: bet, result: result,
              win: winner.id === opponent.id, yourBalance: opponent.balance, enemyBalance: challenger.balance
            }));
            challenger.ws.send(JSON.stringify({
              type: 'coinflip_result', opponent: opponent.nick, bet: bet, result: result,
              win: winner.id === challenger.id, yourBalance: challenger.balance, enemyBalance: opponent.balance
            }));
            broadcastPlayers();
          } else {
            coinflipQueue.push(ws.id);
            ws.send(JSON.stringify({ type: 'coinflip_wait' }));
          }
        } else {
          coinflipQueue.push(ws.id);
          ws.send(JSON.stringify({ type: 'coinflip_wait' }));
        }
        break;
      }

      case 'create_battle': {
        if (!players[ws.id]) return;
        const battleId = 'b_' + Date.now();
        caseBattles[battleId] = {
          id: battleId, 
          host: ws.id, 
          hostNick: players[ws.id].nick, 
          hostAvatar: players[ws.id].avatar,
          price: data.price, 
          caseCount: data.count || 1,
          status: 'waiting', 
          players: [ws.id]
        };
        broadcastBattles();
        break;
      }

      case 'join_battle': {
        const battle = caseBattles[data.battleId];
        if (!battle || battle.status !== 'waiting' || battle.host === ws.id) return;
        if (!players[ws.id] || !players[battle.host]) return;

        const host = players[battle.host];
        const guest = players[ws.id];

        if (host.balance < battle.price || guest.balance < battle.price) {
          ws.send(JSON.stringify({ type: 'error', message: 'У кого-то не хватает монет' }));
          return;
        }

        battle.status = 'playing';
        host.balance -= battle.price;
        guest.balance -= battle.price;
        
        // Отправляем сигнал, что батл начался (чтобы клиент запустил анимацию)
        const startData = {
          type: 'battle_start',
          enemy: { nick: guest.nick, avatar: guest.avatar },
          isHost: true
        };
        host.ws.send(JSON.stringify(startData));
        
        const startDataGuest = {
          type: 'battle_start',
          enemy: { nick: host.nick, avatar: host.avatar },
          isHost: false
        };
        guest.ws.send(JSON.stringify(startDataGuest));

        // Ждем 3.5 секунды, пока крутятся рулетки, и отправляем результат
        setTimeout(() => {
          const hostScore = Math.floor(Math.random() * 5000) + battle.price;
          const guestScore = Math.floor(Math.random() * 5000) + battle.price;
          let winnerId = hostScore >= guestScore ? host.id : guest.id;
          const winner = winnerId === host.id ? host : guest;
          winner.balance += battle.price * 2;

          if (host.ws.readyState === WebSocket.OPEN) {
            host.ws.send(JSON.stringify({ 
              type: 'battle_result', 
              myScore: hostScore, 
              enemyScore: guestScore, 
              win: winnerId === host.id 
            }));
          }
          if (guest.ws.readyState === WebSocket.OPEN) {
            guest.ws.send(JSON.stringify({ 
              type: 'battle_result', 
              myScore: guestScore, 
              enemyScore: hostScore, 
              win: winnerId === guest.id 
            }));
          }
          
          delete caseBattles[battle.id];
          broadcastBattles();
          broadcastPlayers();
        }, 4000);
        
        broadcastBattles();
        break;
      }
    }
  });

  ws.on('close', () => {
    delete players[ws.id];
    coinflipQueue = coinflipQueue.filter(id => id !== ws.id);
    for (const key in caseBattles) {
      if (caseBattles[key].host === ws.id && caseBattles[key].status === 'waiting') {
        delete caseBattles[key];
      }
    }
    broadcastOnlineCount();
    broadcastBattles();
    broadcastPlayers();
  });
});

function broadcastOnlineCount() {
  sendToAll({ type: 'online_count', count: Object.keys(players).length });
}

function broadcastBattles() {
  const list = Object.values(caseBattles)
    .filter(b => b.status === 'waiting')
    .map(b => ({ 
      id: b.id, 
      hostNick: b.hostNick, 
      hostAvatar: b.hostAvatar, 
      price: b.price,
      caseCount: b.caseCount
    }));
  sendToAll({ type: 'battles_list', battles: list });
}

// ЭТА ФУНКЦИЯ ОТВЕЧАЕТ ЗА ТАБЛИЦУ ИГРОКОВ
function broadcastPlayers() {
  const list = Object.values(players)
    .map(p => ({ 
      id: p.id, 
      nick: p.nick, 
      avatar: p.avatar, 
      balance: p.balance 
    }))
    .sort((a, b) => b.balance - a.balance); // Сортируем по балансу (богатые сверху)
    
  // Отправляем как players_list (для таблицы всех игроков)
  sendToAll({ type: 'players_list', players: list });
  
  // Отправляем как leaderboard (для вкладки Топ-10)
  sendToAll({ type: 'leaderboard', list: list.slice(0, 10) });
}

function sendToAll(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { 
    if (c.readyState === WebSocket.OPEN) c.send(msg); 
  });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('✅ Сервер запущен на порту ' + PORT));
