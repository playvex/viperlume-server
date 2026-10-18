'use strict';
/*
 * Viperlume Online — real-time multiplayer server (by Playvex)
 * ------------------------------------------------
 * Zero dependencies. Run:  node server.js
 * Env:  PORT (default 8787)   ALLOWED_ORIGINS (optional, comma separated suffixes)
 *
 * Rooms: public quick-match rooms (short lobby countdown, late joins allowed while
 * enough time remains) and private rooms with a 4-letter code (host starts the round).
 * A round = lobby -> 78 s "grow" phase (all players share one arena) -> boss phase
 * (each player fights their own Heavy Snake locally and reports a final score) -> results.
 *
 * Trust model: casual game. Movement is client-authoritative; the server validates food
 * pick-ups (distance), decides who swallows whom (50% size rule) and keeps the clock.
 */
const VERSION = '0.0.1';
const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8787', 10);
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ---------- game constants (must match the client) ----------
const WORLD = 2000;                // the arena is a 2000 x 2000 world; every screen shows a window of it that follows the player
const HEAD_R = 30;
const MAXP = 8;
const ROUND_MS = parseInt(process.env.ROUND_MS || '78000', 10);
const LOBBY_MS = parseInt(process.env.LOBBY_MS || '10000', 10);
const BOSS_CAP_MS = parseInt(process.env.BOSS_CAP_MS || '110000', 10);
const JOIN_GRACE_MS = 22000;      // a running public room accepts joins only if at least this much time is left
const HOLD_MS = 2600;             // how long a swallowed snake is held
const IMMUNE_MS = 2600;           // extra protection after release
const SPAWN_IMMUNE_MS = 3200;
const FOOD_COUNT = 80;
const FOOD_GROW = 14;
const RAMP_MS = 20000;            // every RAMP_MS of play the prey is worth more and more of it appears
const TICK_MS = 66;               // ~15 Hz
const IDLE_MS = 15000;
const MAX_MSG = 2048;
const MAX_CONN_PER_IP = 8;
const MAX_CONN = 1500;

const sizeOf = gr => 20 + gr / 4;                                   // "largeness" used by the 50% rule
const bodyCount = gr => Math.max(14, Math.min(72, Math.round((18 + gr / 10) * 0.9)));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const elapsedOf = (r, now) => Math.max(0, ROUND_MS - (r.tEnd - (now || Date.now())));
const foodGrow = (r, now) => FOOD_GROW + 3 * Math.min(4, Math.floor(elapsedOf(r, now) / RAMP_MS));
const foodTarget = (r, now) => FOOD_COUNT + 6 * Math.min(4, Math.floor(elapsedOf(r, now) / RAMP_MS));

const ADJ = ['Swift', 'Neon', 'Silent', 'Golden', 'Crimson', 'Azure', 'Lunar', 'Solar', 'Frost', 'Ember', 'Jade', 'Onyx', 'Misty', 'Brave', 'Sly', 'Wild', 'Royal', 'Rapid', 'Sunny', 'Storm'];
const ANI = ['Cobra', 'Mamba', 'Viper', 'Python', 'Adder', 'Boa', 'Asp', 'Taipan', 'Racer', 'Coral', 'Sidewinder', 'Anaconda', 'Krait', 'Rattler', 'Serpent'];
const HUES = [150, 25, 210, 315, 52, 355, 268, 95];               // distinct palettes assigned per player slot

let nextId = 1;
const rooms = new Map();
const conns = new Set();
let connCount = 0;
const ipCount = new Map();

function rnd(a, b) { return a + Math.random() * (b - a); }
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function genName(taken) {
  for (let i = 0; i < 30; i++) {
    const n = pick(ADJ) + ' ' + pick(ANI);
    if (!taken.has(n)) return n;
  }
  return pick(ADJ) + ' ' + pick(ANI) + ' ' + Math.floor(rnd(10, 99));
}
function genCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let k = 0; k < 50; k++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
    if (!rooms.has(c)) return c;
  }
  return 'ZZZZ';
}

// ---------- minimal RFC 6455 WebSocket ----------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn {
  constructor(socket, ip) {
    this.socket = socket; this.ip = ip;
    this.buf = Buffer.alloc(0); this.frag = []; this.fragOp = 0;
    this.alive = true; this.closed = false;
    this.player = null; this.stamp = Date.now(); this.msgs = 0;
    socket.setNoDelay(true);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
  }
  onData(d) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (this.buf.length > 16384) return this.close();
    while (!this.closed && this.parse()) { /* consume frames */ }
  }
  parse() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return false; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return false;
      if (b.readUInt32BE(2) !== 0) { this.close(); return false; }
      len = b.readUInt32BE(6); off = 10;
    }
    if (len > MAX_MSG) { this.close(); return false; }
    if (!masked) { this.close(); return false; }
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    this.frame(fin, op, payload);
    return true;
  }
  frame(fin, op, p) {
    if (op === 8) { this.close(); return; }
    if (op === 9) { this.sendFrame(10, p); return; }
    if (op === 10) { this.alive = true; return; }
    if (op === 1 || op === 2 || op === 0) {
      if (op !== 0) { this.fragOp = op; this.frag = []; }
      this.frag.push(p);
      if (fin) {
        const full = this.frag.length === 1 ? this.frag[0] : Buffer.concat(this.frag);
        this.frag = [];
        if (this.fragOp === 1) this.onText(full.toString('utf8'));
      }
    }
  }
  onText(str) {
    // rate limit: 60 msgs / s
    const now = Date.now();
    if (now - this.stamp > 1000) { this.stamp = now; this.msgs = 0; }
    if (++this.msgs > 60) return;
    let m;
    try { m = JSON.parse(str); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try { handle(this, m); } catch (e) { /* never crash the server on a bad message */ }
  }
  send(o) {
    if (this.closed) return;
    this.sendFrame(1, Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)));
  }
  sendFrame(op, payload) {
    if (this.closed) return;
    if (this.socket.writableLength > 262144) return this.close();   // slow consumer
    const len = payload.length;
    let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
    try { this.socket.write(Buffer.concat([h, payload])); } catch (e) { this.close(); }
  }
  close() {
    if (this.closed) return;
    try { this.sendFrame(8, Buffer.from([0x03, 0xe8])); } catch (e) { /* ignore */ }
    try { this.socket.end(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { this.socket.destroy(); } catch (e) { /* ignore */ } }, 500).unref();
    this.onClose();
  }
  onClose() {
    if (this.closed) return;
    this.closed = true;
    connCount--;
    const n = (ipCount.get(this.ip) || 1) - 1;
    if (n <= 0) ipCount.delete(this.ip); else ipCount.set(this.ip, n);
    if (this.player) leaveRoom(this.player, true);
  }
}

// ---------- rooms ----------
function newRoom(priv) {
  const r = {
    id: nextId++, code: priv ? genCode() : '', priv: !!priv, hostId: 0, bio: Math.floor(Math.random() * 12),
    players: new Map(), food: [], phase: 'lobby', created: Date.now(),
    lobbyEnd: priv ? 0 : Date.now() + LOBBY_MS, tEnd: 0, bossEnd: 0, foodSeq: 1, hueUsed: new Set(), closeAt: 0, lastLob: 0,
  };
  rooms.set(priv ? r.code : 'r' + r.id, r);
  r.key = priv ? r.code : 'r' + r.id;
  return r;
}
function spawnFood(r) {
  const f = { id: r.foodSeq++, x: Math.round(rnd(70, WORLD - 70)), y: Math.round(rnd(70, WORLD - 70)), k: Math.floor(Math.random() * 5) };
  r.food.push(f);
  return f;
}
function bcast(r, o, exceptId) {
  const s = JSON.stringify(o);
  for (const p of r.players.values()) if (p.id !== exceptId) p.conn.send(s);
}
function pubPlayer(p) { return { id: p.id, name: p.name, hue: p.hue }; }
function lobbyMsg(r) {
  return {
    t: 'lob', code: r.code, host: r.hostId, priv: r.priv ? 1 : 0,
    left: r.phase === 'lobby' && !r.priv ? Math.max(0, r.lobbyEnd - Date.now()) : -1,
    players: [...r.players.values()].map(pubPlayer),
  };
}
function safeSpawn(r) {
  let best = null, bd = -1;
  for (let k = 0; k < 14; k++) {
    const x = rnd(260, WORLD - 260), y = rnd(260, WORLD - 260);
    let md = 1e9;
    for (const q of r.players.values()) md = Math.min(md, Math.hypot(q.x - x, q.y - y));
    if (md > bd) { bd = md; best = { x: Math.round(x), y: Math.round(y), a: Math.atan2(WORLD / 2 - y, WORLD / 2 - x) }; }
  }
  return best;
}
function spawnPoint(r, idx) {
  // spread around a ring so nobody starts on top of somebody else
  const a = (idx / MAXP) * Math.PI * 2 + rnd(-0.2, 0.2);
  return { x: Math.round(WORLD / 2 + Math.cos(a) * 700), y: Math.round(WORLD / 2 + Math.sin(a) * 700), a: a + Math.PI };
}
function makePlayer(conn, r) {
  let hue = 0;
  for (let i = 0; i < HUES.length; i++) if (!r.hueUsed.has(i)) { hue = i; break; }
  r.hueUsed.add(hue);
  const taken = new Set([...r.players.values()].map(p => p.name));
  const sp = r.phase === 'grow' ? safeSpawn(r) : spawnPoint(r, r.players.size);
  const p = {
    id: nextId++, conn, room: r, name: genName(taken), hueIdx: hue, hue: HUES[hue],
    x: sp.x, y: sp.y, a: sp.a, gr: 0, hist: [], last: Date.now(), inv: Date.now() + SPAWN_IMMUNE_MS,
    held: 0, done: false, score: 0, win: 0, dead: 0, sp,
  };
  conn.player = p;
  r.players.set(p.id, p);
  if (!r.hostId) r.hostId = p.id;
  return p;
}
function goMsg(r, p) {
  return {
    t: 'go', bio: r.bio, left: Math.max(0, r.tEnd - Date.now()), me: { x: p.sp.x, y: p.sp.y, a: p.sp.a },
    food: r.food.map(f => [f.id, f.x, f.y, f.k]),
    players: [...r.players.values()].filter(q => q.id !== p.id).map(q => ({ id: q.id, name: q.name, hue: q.hue, x: q.x, y: q.y, a: q.a, gr: q.gr })),
  };
}
function startGrow(r) {
  r.phase = 'grow';
  r.tEnd = Date.now() + ROUND_MS;
  r.food = [];
  for (let i = 0; i < FOOD_COUNT; i++) spawnFood(r);
  let i = 0;
  for (const p of r.players.values()) {
    p.sp = spawnPoint(r, i++);
    p.x = p.sp.x; p.y = p.sp.y; p.a = p.sp.a; p.hist = []; p.last = Date.now(); p.inv = Date.now() + SPAWN_IMMUNE_MS;
  }
  for (const p of r.players.values()) p.conn.send(goMsg(r, p));
}
function joinRoom(conn, mode, code) {
  if (conn.player) return;
  let r = null;
  if (mode === 'c') {
    r = newRoom(true);
  } else if (mode === 'j') {
    r = rooms.get(String(code || '').toUpperCase().slice(0, 4));
    if (!r) return conn.send({ t: 'err', c: 'nocode' });
    if (r.players.size >= MAXP) return conn.send({ t: 'err', c: 'full' });
    if (r.phase !== 'lobby' && !(r.phase === 'grow' && r.tEnd - Date.now() > JOIN_GRACE_MS)) return conn.send({ t: 'err', c: 'late' });
  } else {
    let best = null;
    for (const q of rooms.values()) {
      if (q.priv || q.players.size >= MAXP) continue;
      if (q.phase === 'lobby') { if (!best || best.phase !== 'lobby' || q.players.size > best.players.size) best = q; }
      else if (q.phase === 'grow' && q.tEnd - Date.now() > JOIN_GRACE_MS) { if (!best || (best.phase !== 'lobby' && q.players.size > best.players.size)) best = q; }
    }
    r = best || newRoom(false);
  }
  const p = makePlayer(conn, r);
  const late = r.phase === 'grow';
  conn.send({ t: 'joined', id: p.id, name: p.name, hue: p.hue, code: r.code, host: r.hostId === p.id ? 1 : 0, phase: r.phase, priv: r.priv ? 1 : 0 });
  if (late) {
    conn.send(goMsg(r, p));
    bcast(r, { t: 'j', p: { id: p.id, name: p.name, hue: p.hue, x: p.x, y: p.y, a: p.a, gr: 0 } }, p.id);
  } else {
    bcast(r, lobbyMsg(r));
    if (!r.priv && r.players.size >= MAXP) startGrow(r);
  }
}
function leaveRoom(p, silent) {
  const r = p.room;
  if (!r) return;
  r.players.delete(p.id);
  r.hueUsed.delete(p.hueIdx);
  p.conn.player = null; p.room = null;
  if (!r.players.size) { rooms.delete(r.key); return; }
  if (r.hostId === p.id) r.hostId = r.players.keys().next().value;
  if (r.phase === 'lobby') bcast(r, lobbyMsg(r));
  else bcast(r, { t: 'l', id: p.id });
  if (r.phase === 'boss') checkAllDone(r);
}
function standings(r) {
  return [...r.players.values()].filter(p => p.done)
    .sort((a, b) => b.score - a.score)
    .map(p => ({ id: p.id, name: p.name, hue: p.hue, s: Math.floor(p.score), w: p.win ? 1 : 0, d: p.dead ? 1 : 0 }));
}
function checkAllDone(r) {
  if (r.phase !== 'boss') return;
  for (const p of r.players.values()) if (!p.done) return;
  finishRoom(r);
}
function finishRoom(r) {
  if (r.phase === 'end') return;
  r.phase = 'end';
  bcast(r, { t: 'end', r: standings(r) });
  r.closeAt = Date.now() + 4000;
}

// ---------- catches (the 50% rule) ----------
function bodyPoints(p, n, sp) {
  const pts = [{ x: p.x, y: p.y }];
  let px = p.x, py = p.y, acc = 0;
  for (let i = 0; i < p.hist.length && pts.length < n; i++) {
    const b = p.hist[i];
    const dx = b.x - px, dy = b.y - py, d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    let pos = 0;
    while (pts.length < n && acc + (d - pos) >= sp) {
      pos += sp - acc; acc = 0;
      pts.push({ x: px + dx * (pos / d), y: py + dy * (pos / d) });
    }
    acc += d - pos;
    px = b.x; py = b.y;
  }
  return pts;
}
function detectCatches(r, now) {
  const list = [...r.players.values()].filter(p => !p.done);
  for (const e of list) {
    if (e.held > now) continue;
    const se = sizeOf(e.gr);
    for (const v of list) {
      if (v === e || v.held > now || v.inv > now) continue;
      if (se < 1.5 * sizeOf(v.gr)) continue;
      const pts = bodyPoints(v, bodyCount(v.gr), HEAD_R * 0.5);
      const lim = HEAD_R * 1.6;
      let hit = false;
      for (let i = 0; i < pts.length; i++) {
        const dx = pts[i].x - e.x, dy = pts[i].y - e.y;
        if (dx * dx + dy * dy < lim * lim) { hit = true; break; }
      }
      if (!hit) continue;
      const gain = 24 + Math.round(v.gr * 0.4);
      e.gr += gain;
      v.gr = Math.max(0, v.gr - 99);
      v.held = now + HOLD_MS;
      v.inv = now + HOLD_MS + IMMUNE_MS;
      bcast(r, { t: 'c', v: v.id, e: e.id, g: gain, vg: v.gr, eg: e.gr });
    }
  }
}

// ---------- message handling ----------
function handle(conn, m) {
  const p = conn.player, r = p && p.room;
  switch (m.t) {
    case 'hi': {
      const mode = m.m === 'c' ? 'c' : m.m === 'j' ? 'j' : 'q';
      joinRoom(conn, mode, m.code);
      break;
    }
    case 'st':
      conn.send(statsMsg());
      break;
    case 'start':
      if (r && r.phase === 'lobby' && r.hostId === p.id) startGrow(r);
      break;
    case 's': {
      if (!r || r.phase !== 'grow' || p.done) break;
      const x = clamp(+m.x || 0, 0, WORLD), y = clamp(+m.y || 0, 0, WORLD), a = +m.a || 0;
      const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy);
      if (d > 260) p.hist = [];                      // teleport (respawn) -> don't stretch the body across the arena
      else if (d > 5) {
        p.hist.unshift({ x: p.x, y: p.y });
        if (p.hist.length > 160) p.hist.length = 160;
      }
      p.x = x; p.y = y; p.a = a; p.last = Date.now();
      break;
    }
    case 'e': {
      if (!r || r.phase !== 'grow' || p.done) break;
      const id = m.i | 0;
      const i = r.food.findIndex(f => f.id === id);
      if (i < 0) { conn.send({ t: 'rej', i: id }); break; }
      const f = r.food[i];
      const dx = f.x - p.x, dy = f.y - p.y;
      if (dx * dx + dy * dy > 170 * 170) { conn.send({ t: 'rej', i: id }); break; }   // too far from where you last were
      r.food.splice(i, 1);
      p.gr += foodGrow(r);
      const n = spawnFood(r);
      bcast(r, { t: 'f', i: f.id, by: p.id, g: p.gr, n: [n.id, n.x, n.y, n.k] });
      break;
    }
    case 'd': {
      if (!r || p.done) break;
      p.done = true; p.score = clamp(+m.s || 0, 0, 9e6); p.win = m.w ? 1 : 0; p.dead = m.x ? 1 : 0;
      bcast(r, { t: 'res', r: standings(r) });
      if (r.phase === 'boss') checkAllDone(r);
      break;
    }
    case 'x':
      if (p) leaveRoom(p);
      break;
    default: break;
  }
}
function statsMsg() {
  let n = 0;
  for (const r of rooms.values()) n += r.players.size;
  return { t: 'stats', n, r: rooms.size };
}

// ---------- world tick ----------
setInterval(() => {
  const now = Date.now();
  for (const r of [...rooms.values()]) {
    if (r.phase === 'lobby') {
      if (!r.priv && now >= r.lobbyEnd && r.players.size) startGrow(r);
      else if (now - r.lastLob > 1000) { r.lastLob = now; bcast(r, lobbyMsg(r)); }
    } else if (r.phase === 'grow') {
      if (now >= r.tEnd) {
        r.phase = 'boss'; r.bossEnd = now + BOSS_CAP_MS;
        bcast(r, { t: 'ph', p: 'boss' });
        continue;
      }
      for (const p of [...r.players.values()]) {
        if (now - p.last > IDLE_MS) { p.conn.send({ t: 'err', c: 'idle' }); leaveRoom(p); }
      }
      if (!r.players.size) continue;
      detectCatches(r, now);
      const ps = [];
      for (const p of r.players.values()) ps.push([p.id, Math.round(p.x), Math.round(p.y), Math.round(p.a * 100) / 100, p.gr, p.held > now ? 1 : 0]);
      const want = foodTarget(r, now);
      while (r.food.length < want) { const n = spawnFood(r); bcast(r, { t: 'fn', n: [n.id, n.x, n.y, n.k] }); }
      bcast(r, { t: 'w', T: r.tEnd - now, fg: foodGrow(r, now), p: ps });
    } else if (r.phase === 'boss') {
      if (now >= r.bossEnd) finishRoom(r);
    } else if (r.phase === 'end') {
      if (now >= r.closeAt) {
        for (const p of [...r.players.values()]) { p.conn.player = null; p.room = null; }
        rooms.delete(r.key);
      }
    }
  }
}, TICK_MS);

// keep-alive + periodic stats for connections that are just browsing the lobby screen
setInterval(() => {
  const st = JSON.stringify(statsMsg());
  for (const c of conns) {
    if (!c.alive) { c.close(); continue; }
    c.alive = false;
    c.sendFrame(9, Buffer.alloc(0));
    if (!c.player) c.send(st);
  }
}, 20000).unref();

// ---------- http + upgrade ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const s = statsMsg();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, game: 'viperlume', version: VERSION, players: s.n, rooms: s.r }));
  } else { res.writeHead(404); res.end(); }
});
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const ip = String((req.headers['x-forwarded-for'] || socket.remoteAddress || '')).split(',')[0].trim();
  const origin = String(req.headers.origin || '').toLowerCase();
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  if (ORIGINS.length && origin && !ORIGINS.some(o => origin.endsWith(o))) { console.log('blocked origin:', origin); socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  if (connCount >= MAX_CONN || (ipCount.get(ip) || 0) >= MAX_CONN_PER_IP) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  connCount++; ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  const c = new Conn(socket, ip);
  conns.add(c);
  socket.on('close', () => conns.delete(c));
  c.send(statsMsg());
});
server.listen(PORT, () => console.log('Viperlume server listening on :' + PORT));
process.on('SIGTERM', () => { for (const c of conns) c.close(); setTimeout(() => process.exit(0), 300); });
process.on('uncaughtException', e => console.error('uncaught', e && e.stack || e));
