const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Dark Horror Online Server');
});

const wss = new WebSocket.Server({ server });

let players = {};
let monster = { x: 400, y: 400, target: null };

// Стены: [x, y, width, height]
const WALLS = [
  // Внешние стены
  {x: 0, y: 0, w: 800, h: 20}, {x: 0, y: 780, w: 800, h: 20},
  {x: 0, y: 0, w: 20, h: 800}, {x: 780, y: 0, w: 20, h: 800},
  // Внутренние стены (лабиринт)
  {x: 200, y: 200, w: 20, h: 400}, {x: 400, y: 0, w: 20, h: 300},
  {x: 600, y: 200, w: 20, h: 400}, {x: 200, y: 600, w: 400, h: 20},
  {x: 400, y: 400, w: 200, h: 20}
];

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substring(2, 9);
  ws.send(JSON.stringify({ type: 'welcome', id: ws.id }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        players[ws.id] = { id: ws.id, nick: data.nick, skin: data.skin || '👤', x: 50, y: 50, hp: 100, alive: true };
        broadcast({ type: 'players_update', players: Object.values(players) });
      }

      if (data.type === 'move') {
        if (players[ws.id] && players[ws.id].alive) {
          players[ws.id].x = data.x;
          players[ws.id].y = data.y;
          broadcast({ type: 'players_update', players: Object.values(players) });
        }
      }

      if (data.type === 'chat') {
        if (players[ws.id]) {
          broadcast({ type: 'chat', from: players[ws.id].nick, text: data.text });
        }
      }

      if (data.type === 'kill') {
        if (players[ws.id]) {
          players[ws.id].alive = false;
          broadcast({ type: 'system', text: `💀 Монстр убил ${players[ws.id].nick}!` });
          broadcast({ type: 'players_update', players: Object.values(players) });
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    delete players[ws.id];
    broadcast({ type: 'players_update', players: Object.values(players) });
  });
});

// Движение монстра
setInterval(() => {
  if (Object.keys(players).length > 0) {
    const alivePlayers = Object.values(players).filter(p => p.alive);
    if (alivePlayers.length > 0) {
      // Ищем ближайшего игрока
      let closest = alivePlayers[0];
      let minDist = Infinity;
      alivePlayers.forEach(p => {
        const dist = Math.hypot(p.x - monster.x, p.y - monster.y);
        if (dist < minDist) { minDist = dist; closest = p; }
      });

      // Двигаемся к нему (скорость 2)
      const dx = closest.x - monster.x;
      const dy = closest.y - monster.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        monster.x += (dx / len) * 1.5;
        monster.y += (dy / len) * 1.5;
      }
      
      broadcast({ type: 'monster_update', x: monster.x, y: monster.y });

      // Если догнал — убивает
      if (minDist < 20) {
        closest.alive = false;
        broadcast({ type: 'system', text: `💀 Монстр поймал ${closest.nick}!` });
        broadcast({ type: 'players_update', players: Object.values(players) });
      }
    }
  }
}, 100);

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('✅ Сервер запущен на ' + PORT));
