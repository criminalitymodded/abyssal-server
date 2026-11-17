// ABYSSAL lobby + WebRTC voice signaling server
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.get('/', (_req, res) => res.send('ABYSSAL server online'));
app.get('/health', (_req, res) => res.json({ ok: true, lobbies: lobbies.size }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const MAX_PLAYERS = 4;
const lobbies = new Map(); // code -> {code,name,isPrivate,host,players:Map(id->{id,name,x,y,z,ry})}
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function code() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s; do { s = Array.from({ length: 5 }, () => c[Math.floor(Math.random() * c.length)]).join(''); } while (lobbies.has(s));
  return s;
}
function publicList() {
  return [...lobbies.values()].filter(l => !l.isPrivate && !l.started)
    .map(l => ({ code: l.code, name: l.name, players: l.players.size, max: MAX_PLAYERS }));
}
function lobbyState(l) {
  return { code: l.code, name: l.name, isPrivate: l.isPrivate, host: l.host, started: !!l.started,
    players: [...l.players.values()].map(p => ({ id: p.id, name: p.name, ready: !!p.ready })) };
}
function leave(socket) {
  const c = socket.data.lobby; if (!c) return;
  const l = lobbies.get(c); socket.leave(c); socket.data.lobby = null;
  if (!l) return;
  l.players.delete(socket.id);
  socket.to(c).emit('player:left', { id: socket.id });
  if (l.players.size === 0) lobbies.delete(c);
  else { if (l.host === socket.id) l.host = l.players.keys().next().value; io.to(c).emit('lobby:state', lobbyState(l)); }
  io.emit('lobby:list', publicList());
}

io.on('connection', (socket) => {
  socket.emit('lobby:list', publicList());

  socket.on('hello', ({ name } = {}, cb) => {
    if (!NAME_RE.test(name || '')) return cb && cb({ error: 'Bad name' });
    socket.data.name = name; cb && cb({ ok: true, id: socket.id });
  });
  socket.on('lobby:list', (_ = {}, cb) => cb && cb(publicList()));

  socket.on('lobby:create', ({ name, isPrivate } = {}, cb) => {
    if (!socket.data.name) return cb && cb({ error: 'Say hello first' });
    leave(socket);
    const l = { code: code(), name: String(name || socket.data.name + "'s lobby").slice(0, 24), isPrivate: !!isPrivate, host: socket.id, players: new Map() };
    lobbies.set(l.code, l);
    join(socket, l, cb);
  });
  socket.on('lobby:join', ({ code: c } = {}, cb) => {
    const l = lobbies.get(String(c || '').toUpperCase());
    if (!l) return cb && cb({ error: 'Lobby not found' });
    if (l.players.size >= MAX_PLAYERS) return cb && cb({ error: 'Lobby full' });
    if (l.started) return cb && cb({ error: 'Game already started' });
    leave(socket); join(socket, l, cb);
  });
  function join(sock, l, cb) {
    l.players.set(sock.id, { id: sock.id, name: sock.data.name });
    sock.join(l.code); sock.data.lobby = l.code;
    sock.to(l.code).emit('player:joined', { id: sock.id, name: sock.data.name });
    io.to(l.code).emit('lobby:state', lobbyState(l));
    io.emit('lobby:list', publicList());
    cb && cb({ ok: true, lobby: lobbyState(l) });
  }
  socket.on('lobby:leave', () => leave(socket));
  socket.on('lobby:ready', (ready) => {
    const l = lobbies.get(socket.data.lobby); if (!l) return;
    const p = l.players.get(socket.id); if (p) p.ready = !!ready;
    io.to(l.code).emit('lobby:state', lobbyState(l));
  });
  socket.on('lobby:start', (_ = {}, cb) => {
    const l = lobbies.get(socket.data.lobby); if (!l || l.host !== socket.id) return cb && cb({ error: 'Only host can start' });
    l.started = true; l.seed = Math.floor(Math.random() * 1e9);
    io.to(l.code).emit('game:start', { seed: l.seed });
    io.emit('lobby:list', publicList()); cb && cb({ ok: true });
  });

  // in-game state relay (throttled client-side ~10/s)
  socket.on('state', (s) => { if (socket.data.lobby) socket.volatile.to(socket.data.lobby).emit('state', { id: socket.id, ...s }); });
  socket.on('event', (e) => { if (socket.data.lobby) socket.to(socket.data.lobby).emit('event', { id: socket.id, ...e }); });
  socket.on('chat', (msg) => {
    if (!socket.data.lobby) return;
    io.to(socket.data.lobby).emit('chat', { id: socket.id, name: socket.data.name, text: String(msg || '').slice(0, 200) });
  });

  // WebRTC voice signaling (peer-to-peer audio, server only relays offers/answers/ICE)
  socket.on('rtc:signal', ({ to, data } = {}) => {
    const l = lobbies.get(socket.data.lobby);
    if (l && l.players.has(to)) io.to(to).emit('rtc:signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => leave(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('ABYSSAL server on ' + PORT));
