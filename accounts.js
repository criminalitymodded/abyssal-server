// Player accounts: signup/login, unique names, email linking + verification codes, password change/reset.
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

const DB_URL = (process.env.DATABASE_URL_TEMPLATE || '').replace(/\[YOUR-(DATABASE-)?PASSWORD\]/, encodeURIComponent(process.env.DB_PASSWORD || ''));
const pool = DB_URL ? new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, max: 5 }) : null;
const SECRET = crypto.createHash('sha256').update((process.env.DB_PASSWORD || 'dev') + ':abyssal-session').digest();
const OWNER_NAMES = ['tr1pz2crazy'];
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const BAD = ['fuck','shit','bitch','cunt','dick','cock','pussy','asshole','bastard','slut','whore','twat','wanker','nigger','nigga','faggot','retard','kike','chink','spic','tranny','dyke','rape','nazi'];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function nameBad(n) {
  const low = n.toLowerCase();
  const leet = low.replace(/_/g, '').replace(/[013457]/g, c => ({0:'o',1:'i',3:'e',4:'a',5:'s',7:'t'})[c]);
  return BAD.some(w => low.includes(w) || leet.includes(w));
}
function validName(n) {
  if (!NAME_RE.test(n || '')) return 'Use 3–16 letters, numbers or _.';
  if (nameBad(n)) return "That name isn't allowed.";
  return null;
}
async function init() {
  if (!pool) { console.warn('No database configured; accounts disabled'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS players (
    id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    username_lc TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    email TEXT,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    role TEXT NOT NULL DEFAULT 'player',
    token_ver INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS codes (
    player_id BIGINT NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    email TEXT,
    tries INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (player_id, purpose))`);
  console.log('Accounts DB ready');
}
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return 's1$' + salt.toString('hex') + '$' + h.toString('hex');
}
function checkPw(pw, stored) {
  const [, s, h] = String(stored).split('$');
  const got = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(got, Buffer.from(h, 'hex'));
}
function pwError(pw) { return (typeof pw !== 'string' || pw.length < 8 || pw.length > 72) ? 'Password must be 8–72 characters.' : null; }
function sign(p) {
  const body = Buffer.from(JSON.stringify({ id: p.id, v: p.token_ver, exp: Date.now() + 30 * 864e5 })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
async function fromToken(tok) {
  if (!pool || !tok) return null;
  const [body, sig] = String(tok).split('.');
  if (!body || !sig) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  let d; try { d = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (d.exp < Date.now()) return null;
  const { rows } = await pool.query('SELECT * FROM players WHERE id=$1', [d.id]);
  return rows[0] && rows[0].token_ver === d.v ? rows[0] : null;
}
function pub(p) {
  return { username: p.username, role: p.role, email: p.email ? maskEmail(p.email) : null, emailVerified: p.email_verified, created: p.created_at };
}
function maskEmail(e) { const [u, d] = e.split('@'); return u.slice(0, 2) + '***@' + d; }

// --- email codes (Brevo) ---
async function sendMail(to, subject, text) {
  if (!process.env.BREVO_API_KEY) throw new Error('Email not configured');
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: 'ABYSSAL', email: process.env.MAIL_FROM }, to: [{ email: to }], subject, textContent: text }),
  });
  if (!r.ok) throw new Error('Email send failed ' + r.status);
}
async function issueCode(player, purpose, email) {
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const h = crypto.createHash('sha256').update(code + purpose + player.id).digest('hex');
  await pool.query(`INSERT INTO codes (player_id,purpose,code_hash,email,tries,expires_at) VALUES ($1,$2,$3,$4,0,now()+interval '10 minutes')
    ON CONFLICT (player_id,purpose) DO UPDATE SET code_hash=$3,email=$4,tries=0,expires_at=now()+interval '10 minutes'`, [player.id, purpose, h, email]);
  const what = { link: 'link this email to your account', password: 'change your password', reset: 'reset your password' }[purpose];
  await sendMail(email, 'Your ABYSSAL code: ' + code,
    `Hi ${player.username},\n\nYour ABYSSAL code is ${code}. Use it to ${what}. It expires in 10 minutes.\n\nIf you didn't ask for this, ignore this email.`);
}
async function useCode(player, purpose, code) {
  const { rows } = await pool.query('SELECT * FROM codes WHERE player_id=$1 AND purpose=$2', [player.id, purpose]);
  const c = rows[0];
  if (!c || new Date(c.expires_at) < new Date()) return { error: 'Code expired. Request a new one.' };
  if (c.tries >= 5) return { error: 'Too many tries. Request a new code.' };
  const h = crypto.createHash('sha256').update(String(code || '').trim() + purpose + player.id).digest('hex');
  if (h !== c.code_hash) { await pool.query('UPDATE codes SET tries=tries+1 WHERE player_id=$1 AND purpose=$2', [player.id, purpose]); return { error: 'Wrong code.' }; }
  await pool.query('DELETE FROM codes WHERE player_id=$1 AND purpose=$2', [player.id, purpose]);
  return { ok: true, email: c.email };
}

// --- tiny rate limiter ---
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(); const a = (hits.get(key) || []).filter(t => now - t < ms); a.push(now); hits.set(key, a); return a.length > max;
}
setInterval(() => hits.clear(), 3600e3);

// --- random names ---
const ADJ = ['Lost','Silent','Pale','Hollow','Grim','Foggy','Wary','Ashen','Quiet','Night','Feral','Rusty','Shady','Cold','Lone','Swift','Dusky','Wild'];
const NOUN = ['Ranger','Camper','Hiker','Scout','Wanderer','Drifter','Watcher','Survivor','Pine','Owl','Fox','Lantern','Trapper','Hunter','Echo','Shadow'];
function randomName() { return ADJ[crypto.randomInt(ADJ.length)] + NOUN[crypto.randomInt(NOUN.length)] + crypto.randomInt(10, 999); }

function router(isOnline) {
  const r = express.Router();
  r.use(express.json({ limit: '4kb' }));
  const need = (h) => async (req, res) => {
    try {
      if (!pool) return res.status(503).json({ error: 'Accounts are offline right now.' });
      await h(req, res);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error. Try again.' }); }
  };
  const auth = (h) => need(async (req, res) => {
    const p = await fromToken((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!p) return res.status(401).json({ error: 'Please log in again.' });
    req.player = p; await h(req, res);
  });
  async function taken(n) {
    const lc = n.toLowerCase();
    if (isOnline(lc)) return true;
    if (!pool) return false;
    const { rows } = await pool.query('SELECT 1 FROM players WHERE username_lc=$1', [lc]);
    return rows.length > 0;
  }

  r.get('/names/random', need(async (_q, res) => {
    for (let i = 0; i < 20; i++) { const n = randomName(); if (!(await taken(n))) return res.json({ name: n }); }
    res.json({ name: randomName() });
  }));
  r.get('/names/check', need(async (req, res) => {
    const n = String(req.query.name || ''); const e = validName(n);
    if (e) return res.json({ ok: false, error: e });
    res.json((await taken(n)) ? { ok: false, error: 'That name is taken.' } : { ok: true });
  }));
  r.post('/auth/signup', need(async (req, res) => {
    if (limited('su' + req.ip, 5, 3600e3)) return res.status(429).json({ error: 'Too many sign-ups. Try later.' });
    const { username, password } = req.body || {};
    const e = validName(username) || pwError(password); if (e) return res.status(400).json({ error: e });
    if (isOnline(username.toLowerCase())) return res.status(409).json({ error: 'That name is taken.' });
    const role = OWNER_NAMES.includes(username.toLowerCase()) ? 'owner' : 'player';
    try {
      const { rows } = await pool.query('INSERT INTO players (username,username_lc,pass_hash,role) VALUES ($1,$2,$3,$4) RETURNING *',
        [username, username.toLowerCase(), hashPw(password), role]);
      res.json({ token: sign(rows[0]), player: pub(rows[0]) });
    } catch (err) { if (err.code === '23505') return res.status(409).json({ error: 'That name is taken.' }); throw err; }
  }));
  r.post('/auth/login', need(async (req, res) => {
    const { username, password } = req.body || {};
    if (limited('li' + req.ip, 10, 600e3) || limited('lu' + String(username).toLowerCase(), 8, 600e3)) return res.status(429).json({ error: 'Too many tries. Wait 10 minutes.' });
    const { rows } = await pool.query('SELECT * FROM players WHERE username_lc=$1', [String(username || '').toLowerCase()]);
    if (!rows[0] || !checkPw(String(password || ''), rows[0].pass_hash)) return res.status(401).json({ error: 'Wrong username or password.' });
    res.json({ token: sign(rows[0]), player: pub(rows[0]) });
  }));
  r.get('/me', auth(async (req, res) => res.json({ player: pub(req.player) })));

  // link email: send code to the new address, then verify
  r.post('/account/email/start', auth(async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (limited('em' + req.player.id, 5, 3600e3)) return res.status(429).json({ error: 'Too many codes. Try later.' });
    await issueCode(req.player, 'link', email); res.json({ ok: true, sentTo: maskEmail(email) });
  }));
  r.post('/account/email/verify', auth(async (req, res) => {
    const c = await useCode(req.player, 'link', (req.body || {}).code); if (c.error) return res.status(400).json(c);
    const { rows } = await pool.query('UPDATE players SET email=$1,email_verified=true WHERE id=$2 RETURNING *', [c.email, req.player.id]);
    res.json({ ok: true, player: pub(rows[0]) });
  }));
  // change password: code to linked email required
  r.post('/account/password/start', auth(async (req, res) => {
    if (!req.player.email_verified) return res.status(400).json({ error: 'Link an email first.' });
    if (limited('pw' + req.player.id, 5, 3600e3)) return res.status(429).json({ error: 'Too many codes. Try later.' });
    await issueCode(req.player, 'password', req.player.email); res.json({ ok: true, sentTo: maskEmail(req.player.email) });
  }));
  r.post('/account/password/change', auth(async (req, res) => {
    const { code, currentPassword, newPassword } = req.body || {};
    const e = pwError(newPassword); if (e) return res.status(400).json({ error: e });
    if (!checkPw(String(currentPassword || ''), req.player.pass_hash)) return res.status(401).json({ error: 'Current password is wrong.' });
    const c = await useCode(req.player, 'password', code); if (c.error) return res.status(400).json(c);
    const { rows } = await pool.query('UPDATE players SET pass_hash=$1, token_ver=token_ver+1 WHERE id=$2 RETURNING *', [hashPw(newPassword), req.player.id]);
    res.json({ ok: true, token: sign(rows[0]) });
  }));
  // forgot password
  r.post('/auth/forgot', need(async (req, res) => {
    const u = String((req.body || {}).username || '').toLowerCase();
    if (limited('fg' + req.ip, 5, 3600e3)) return res.status(429).json({ error: 'Too many tries. Try later.' });
    const { rows } = await pool.query('SELECT * FROM players WHERE username_lc=$1', [u]);
    if (rows[0] && rows[0].email_verified) await issueCode(rows[0], 'reset', rows[0].email);
    res.json({ ok: true, message: 'If that account has a linked email, a code is on its way.' });
  }));
  r.post('/auth/reset', need(async (req, res) => {
    const { username, code, newPassword } = req.body || {};
    const e = pwError(newPassword); if (e) return res.status(400).json({ error: e });
    const { rows } = await pool.query('SELECT * FROM players WHERE username_lc=$1', [String(username || '').toLowerCase()]);
    if (!rows[0]) return res.status(400).json({ error: 'Wrong code.' });
    const c = await useCode(rows[0], 'reset', code); if (c.error) return res.status(400).json(c);
    const up = await pool.query('UPDATE players SET pass_hash=$1, token_ver=token_ver+1 WHERE id=$2 RETURNING *', [hashPw(newPassword), rows[0].id]);
    res.json({ token: sign(up.rows[0]), player: pub(up.rows[0]) });
  }));
  return r;
}

module.exports = { init, router, fromToken, validName, pool: () => pool };
