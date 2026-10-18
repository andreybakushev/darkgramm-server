const WebSocket = require('ws');
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Dark Horror 3D Server');
});

const wss = new WebSocket.Server({ server });

let rooms = {}; // { roomCode: { players: {}, monster: {x, y} } }

// Карта (Стены)
const WALLS = [
  {x: 0, y: 0, w: 1000, h: 20}, {x: 0, y: 980, w: 1000, h: 20},
  {x: 0, y: 0, w: 20, h: 1000}, {x: 980, y: 0, w: 20, h: 1000},
  {x: 200, y: 200, w: 20, h: 600}, {x: 400, y: 0, w: 20, h: 400},
  {x: 600, y: 200, w: 20, h: 600}, {x: 200, y: 800, w: 400, h: 20},
  {x: 400, y: 500, w: 200, h: 20}, {x: 100, y: 100, w: 50, h: 20},
  {x: 700, y: 600, w: 20, h: 150}, {x: 300, y: 300, w: 80, h: 80},
  {x: 800, y: 100, w: 100, h: 20}, {x: 100, y: 700, w: 100, h: 20}
];

// Точки спавна ключей (случайные при создании комнаты)
function generateKeys() {
  return [
    { x: 150 + Math.random()*100, y: 150 + Math.random()*100, taken: false },
    { x: 700 + Math.random()*100, y: 700 + Math.random()*100, taken: false },
    { x: 400 + Math.random()*100, y: 200 + Math.random()*100, taken: false }
  ];
}

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substring(2, 9);
  ws.room = null;
  ws.send(JSON.stringify({ type: 'welcome', id: ws.id }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'create_room') {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[code] = {
          players: {},
          monster: { x: 900, y: 900 },
          keys: generateKeys()
        };
        ws.room = code;
        rooms[code].players[ws.id] = { id: ws.id, nick: data.nick, skin: data.skin, x: 50, y: 50, hp: 100, alive: true };
        ws.send(JSON.stringify({ type: 'room_created', code: code }));
        broadcastRoom(code, { type: 'players_update', players: Object.values(rooms[code].players) });
      }

      if (data.type === 'join_room') {
        const code = data.code;
        if (rooms[code]) {
          ws.room = code;
          rooms[code].players[ws.id] = { id: ws.id, nick: data.nick, skin: data.skin, x: 50, y: 50, hp: 100, alive: true };
          ws.send(JSON.stringify({ type: 'room_joined', code: code }));
          broadcastRoom(code, { type: 'players_update', players: Object.values(rooms[code].players) });
          broadcastRoom(code, { type: 'system', text: `${data.nick} присоединился к кошмару!` });
        } else {
          ws.send(JSON.stringify({ type: 'error', text: 'Комната не найдена' }));
        }
      }

      if (data.type === 'move' && ws.room) {
        if (rooms[ws.room] && rooms[ws.room].players[ws.id]) {
          rooms[ws.room].players[ws.id].x = data.x;
          rooms[ws.room].players[ws.id].y = data.y;
          rooms[ws.room].players[ws.id].angle = data.angle;
          broadcastRoom(ws.room, { type: 'players_update', players: Object.values(rooms[ws.room].players) });
        }
      }

      if (data.type === 'chat' && ws.room) {
        if (rooms[ws.room] && rooms[ws.room].players[ws.id]) {
          broadcastRoom(ws.room, { type: 'chat', from: rooms[ws.room].players[ws.id].nick, text: data.text });
        }
      }
      
      if (data.type === 'pickup_key' && ws.room) {
        if (rooms[ws.room] && rooms[ws.room].keys[data.index]) {
           rooms[ws.room].keys[data.index].taken = true;
           broadcastRoom(ws.room, { type: 'keys_update', keys: rooms[ws.room].keys });
        }
      }

    } catch (e) {}
  });

  ws.on('close', () => {
    if (ws.room && rooms[ws.room]) {
      if (rooms[ws.room].players[ws.id]) {
        broadcastRoom(ws.room, { type: 'system', text: `${rooms[ws.room].players[ws.id].nick} сбежал из игры...` });
        delete rooms[ws.room].players[ws.id];
        broadcastRoom(ws.room, { type: 'players_update', players: Object.values(rooms[ws.room].players) });
      }
      if (Object.keys(rooms[ws.room].players).length === 0) delete rooms[ws.room];
    }
  });
});

// Движение и агрессия монстра
setInterval(() => {
  for (let code in rooms) {
    const room = rooms[code];
    const alivePlayers = Object.values(room.players).filter(p => p.alive);
    
    if (alivePlayers.length > 0) {
      let closest = alivePlayers[0];
      let minDist = Infinity;
      
      alivePlayers.forEach(p => {
        const dist = Math.hypot(p.x - room.monster.x, p.y - room.monster.y);
        if (dist < minDist) { minDist = dist; closest = p; }
      });

      // Монстр становится быстрее, если игрок близко (агрессия)
      let speed = minDist < 150 ? 3.5 : 1.8;
      
      const dx = closest.x - room.monster.x;
      const dy = closest.y - room.monster.y;
      const len = Math.hypot(dx, dy);
      
      if (len > 0) {
        // Проверка, чтобы монстр не проходил сквозь стены (упрощенно)
        let nextX = room.monster.x + (dx / len) * speed;
        let nextY = room.monster.y + (dy / len) * speed;
        
        // Простая коллизия для монстра
        let canMove = true;
        for(let w of WALLS) {
           if (nextX > w.x && nextX < w.x + w.w && nextY > w.y && nextY < w.y + w.h) canMove = false;
        }
        
        if(canMove) {
           room.monster.x = nextX;
           room.monster.y = nextY;
        } else {
           // Если врезался в стену, пытается обойти (двигается по другой оси)
           room.monster.y += (dy / len) * speed;
        }
      }
      
      broadcastRoom(code, { type: 'monster_update', x: room.monster.x, y: room.monster.y });

      if (minDist < 30) {
        closest.alive = false;
        closest.hp = 0;
        broadcastRoom(code, { type: 'system', text: `💀 МОНСТР РАЗОРВАЛ ${closest.nick}!` });
        broadcastRoom(code, { type: 'players_update', players: Object.values(room.players) });
      }
    }
  }
}, 100);

function broadcastRoom(code, obj) {
  if (!rooms[code]) return;
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.room === code) c.send(msg);
  });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('✅ Хоррор-сервер запущен на ' + PORT));
