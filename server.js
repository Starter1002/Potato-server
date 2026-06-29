// ==============================================
//  PATATA CALIENTE — Servidor multijugador
//  Node.js + Express + Socket.IO
// ==============================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// ---- Configuración del juego ----
const ARENA_W = 800;
const ARENA_H = 600;
const MAX_PLAYERS = 4;
const BOMB_TIME = 15;          // segundos que dura la bomba antes de explotar
const PASS_DISTANCE = 42;      // distancia (px lógicos) para pasar la bomba al tocar a alguien
const PASS_COOLDOWN_MS = 1000; // evita que la bomba vuelva de inmediato a quien la acaba de pasar
const POWERUP_DESPAWN_MS = 5000;   // si no se recoge en 5s, desaparece
const POWERUP_PICKUP_DIST = 28;
const POWERUP_SPAWN_MIN_MS = 8000;
const POWERUP_SPAWN_MAX_MS = 14000;

const POWERUP_TYPES = ['dash', 'protection', 'invisibility'];
const POWERUP_DURATIONS_MS = {
  dash: 6000,          // +5% velocidad (duración no especificada, valor por defecto)
  protection: 3000,    // exacto según lo pedido
  invisibility: 5000   // exacto según lo pedido
};

const COLORS = ['#ff4d4d', '#4da6ff', '#4dff88', '#ffd24d'];

const rooms = {}; // rooms[code] = { hostId, players, started, bombHolder, bombTimeLeft, powerups, tickHandle, lastPowerupSpawn, nextSpawnDelay }

function genRoomCode() {
  const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numeros = '0123456789';
  let c = '';
  for (let i = 0; i < 2; i++) c += letras[Math.floor(Math.random() * letras.length)];
  for (let i = 0; i < 3; i++) c += numeros[Math.floor(Math.random() * numeros.length)];
  return c;
}

function publicPlayers(room) {
  return Object.values(room.players).map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    x: p.x,
    y: p.y,
    hasBomb: room.bombHolder === p.id,
    powerUp: p.powerUp,
    powerUpExpiresAt: p.powerUpExpiresAt,
    protectionUntil: p.protectionUntil,
    invisibleUntil: p.invisibleUntil,
    alive: p.alive
  }));
}

function randomSpawnDelay() {
  return POWERUP_SPAWN_MIN_MS + Math.random() * (POWERUP_SPAWN_MAX_MS - POWERUP_SPAWN_MIN_MS);
}

function applyPowerup(p, type, now) {
  p.powerUp = type;
  p.powerUpExpiresAt = now + POWERUP_DURATIONS_MS[type];
  if (type === 'protection') p.protectionUntil = now + POWERUP_DURATIONS_MS.protection;
  if (type === 'invisibility') p.invisibleUntil = now + POWERUP_DURATIONS_MS.invisibility;
  // dash: el cliente aplica el bonus de velocidad localmente leyendo powerUp + powerUpExpiresAt
}

function endGame(roomCode, loserId) {
  const room = rooms[roomCode];
  if (!room) return;
  clearInterval(room.tickHandle);
  room.tickHandle = null;
  room.started = false;
  if (room.players[loserId]) room.players[loserId].alive = false;
  const winners = Object.keys(room.players).filter(id => id !== loserId);
  io.to(roomCode).emit('gameOver', { loserId, winners });
}

function startTick(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.tickHandle = setInterval(() => {
    if (!room.started) return;
    const now = Date.now();
    const dt = 0.1; // segundos (coincide con el intervalo de 100ms)

    // --- temporizador de la bomba ---
    room.bombTimeLeft -= dt;
    if (room.bombTimeLeft <= 0) {
      endGame(roomCode, room.bombHolder);
      return;
    }

    // --- pase de la bomba por contacto ---
    const holder = room.players[room.bombHolder];
    if (holder) {
      for (const id in room.players) {
        if (id === room.bombHolder) continue;
        const p = room.players[id];
        if (!p.alive) continue;
        if (now < (p.passCooldownUntil || 0)) continue;
        if (now < p.protectionUntil) continue; // Protection: no le pueden pasar la bomba
        const dx = p.x - holder.x, dy = p.y - holder.y;
        if (Math.hypot(dx, dy) < PASS_DISTANCE) {
          holder.passCooldownUntil = now + PASS_COOLDOWN_MS;
          room.bombHolder = id;
          room.bombTimeLeft = BOMB_TIME;
          io.to(roomCode).emit('bombPassed', { newHolderId: id });
          break;
        }
      }
    }

    // --- spawn de power-ups (solo 1 a la vez en el suelo) ---
    if (room.powerups.length === 0 && now - room.lastPowerupSpawn > room.nextSpawnDelay) {
      const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
      const pu = {
        id: 'pu_' + now + '_' + Math.floor(Math.random() * 1000),
        type,
        x: 40 + Math.random() * (ARENA_W - 80),
        y: 40 + Math.random() * (ARENA_H - 80),
        spawnedAt: now
      };
      room.powerups.push(pu);
      room.lastPowerupSpawn = now;
      room.nextSpawnDelay = randomSpawnDelay();
      io.to(roomCode).emit('powerupSpawned', pu);
    }

    // --- despawn (5s) y recogida de power-ups ---
    room.powerups = room.powerups.filter(pu => {
      if (now - pu.spawnedAt > POWERUP_DESPAWN_MS) {
        io.to(roomCode).emit('powerupDespawned', { id: pu.id });
        return false;
      }
      for (const id in room.players) {
        const p = room.players[id];
        if (!p.alive) continue;
        if (p.powerUp && now < p.powerUpExpiresAt) continue; // ya tiene un efecto activo
        const dx = p.x - pu.x, dy = p.y - pu.y;
        if (Math.hypot(dx, dy) < POWERUP_PICKUP_DIST) {
          applyPowerup(p, pu.type, now);
          io.to(roomCode).emit('powerupCollected', { playerId: id, type: pu.type });
          io.to(roomCode).emit('powerupDespawned', { id: pu.id });
          return false;
        }
      }
      return true;
    });

    // --- expirar efectos activos ---
    for (const id in room.players) {
      const p = room.players[id];
      if (p.powerUp && now > p.powerUpExpiresAt) p.powerUp = null;
    }

    io.to(roomCode).emit('stateUpdate', {
      players: publicPlayers(room),
      bombTimeLeft: Math.max(0, room.bombTimeLeft),
      powerups: room.powerups.map(pu => ({ id: pu.id, x: pu.x, y: pu.y, type: pu.type }))
    });
  }, 100);
}

function joinRoomInternal(socket, code, name) {
  const room = rooms[code];
  const usedColors = Object.values(room.players).map(p => p.color);
  const color = COLORS.find(c => !usedColors.includes(c)) || COLORS[0];

  room.players[socket.id] = {
    id: socket.id,
    name: (name || 'Jugador').slice(0, 12),
    color,
    x: ARENA_W / 2,
    y: ARENA_H / 2,
    powerUp: null,
    powerUpExpiresAt: 0,
    protectionUntil: 0,
    invisibleUntil: 0,
    passCooldownUntil: 0,
    alive: true
  };
  socket.join(code);
  socket.data.roomCode = code;

  socket.emit(room.hostId === socket.id ? 'roomCreated' : 'roomJoined', {
    roomCode: code,
    you: socket.id,
    hostId: room.hostId,
    players: publicPlayers(room)
  });
  io.to(code).emit('playersUpdate', { players: publicPlayers(room), hostId: room.hostId });
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }) => {
    const code = genRoomCode();
    rooms[code] = {
      hostId: socket.id,
      players: {},
      started: false,
      bombHolder: null,
      bombTimeLeft: BOMB_TIME,
      powerups: [],
      tickHandle: null,
      lastPowerupSpawn: Date.now(),
      nextSpawnDelay: randomSpawnDelay()
    };
    joinRoomInternal(socket, code, name);
  });

  socket.on('joinRoom', ({ name, roomCode }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) { socket.emit('joinError', { message: 'Sala no encontrada' }); return; }
    if (Object.keys(room.players).length >= MAX_PLAYERS) { socket.emit('joinError', { message: 'Sala llena (máx. 4)' }); return; }
    if (room.started) { socket.emit('joinError', { message: 'La partida ya empezó' }); return; }
    joinRoomInternal(socket, code, name);
  });

  socket.on('startGame', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.started) return;
    const ids = Object.keys(room.players);
    if (ids.length < 2) return;

    room.started = true;
    room.bombHolder = ids[Math.floor(Math.random() * ids.length)];
    room.bombTimeLeft = BOMB_TIME;
    room.powerups = [];
    room.lastPowerupSpawn = Date.now();
    room.nextSpawnDelay = randomSpawnDelay();

    ids.forEach(id => {
      const p = room.players[id];
      p.x = 100 + Math.random() * (ARENA_W - 200);
      p.y = 100 + Math.random() * (ARENA_H - 200);
      p.powerUp = null; p.powerUpExpiresAt = 0;
      p.protectionUntil = 0; p.invisibleUntil = 0; p.passCooldownUntil = 0;
      p.alive = true;
    });

    io.to(code).emit('gameStarted', {
      players: publicPlayers(room),
      bombHolder: room.bombHolder,
      arenaW: ARENA_W,
      arenaH: ARENA_H
    });
    startTick(code);
  });

  socket.on('move', ({ x, y }) => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room || !room.started) return;
    const p = room.players[socket.id];
    if (!p || !p.alive) return;
    if (typeof x !== 'number' || typeof y !== 'number') return;
    p.x = Math.max(0, Math.min(ARENA_W, x));
    p.y = Math.max(0, Math.min(ARENA_H, y));
  });

  socket.on('returnToLobby', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    room.started = false;
    io.to(code).emit('playersUpdate', { players: publicPlayers(room), hostId: room.hostId });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;

    const hadBomb = room.bombHolder === socket.id;
    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      if (room.tickHandle) clearInterval(room.tickHandle);
      delete rooms[code];
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = Object.keys(room.players)[0];
    }

    if (room.started && hadBomb) {
      const remaining = Object.keys(room.players);
      room.bombHolder = remaining[Math.floor(Math.random() * remaining.length)];
      room.bombTimeLeft = BOMB_TIME;
    }

    io.to(code).emit('playersUpdate', { players: publicPlayers(room), hostId: room.hostId });
  });
});

app.get('/', (req, res) => res.send('Patata Caliente — servidor activo'));

server.listen(PORT, () => console.log('Servidor escuchando en puerto', PORT));
