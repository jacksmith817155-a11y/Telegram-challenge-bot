'use strict';

const fs = require('fs');
const path = require('path');

// DATA_DIR را در Render روی یک Persistent Disk بگذارید (مثلاً /var/data)
// تا با هر دیپلوی داده‌ها پاک نشوند.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

const emptyDb = () => ({
  users: {},         // userId -> { id, name, username }
  subscriptions: {}, // userId -> { until (0 = unlimited), grantedAt }
  banned: {},        // userId -> bannedAt
  groups: {},        // chatId -> { id, title, active, addedAt }
  challenges: [],    // list of finished challenge records
});

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) return emptyDb();
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (err) {
    console.error('DB load failed:', err.message);
    return emptyDb();
  }
}

const data = load();

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (err) {
    console.error('DB save failed:', err.message);
  }
}

// ---------- users ----------
function upsertUser(u) {
  if (!u || u.is_bot) return;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.id);
  const username = u.username || null;
  const old = data.users[u.id];
  if (old && old.name === name && old.username === username) return;
  data.users[u.id] = { id: u.id, name, username };
  save();
}

// ---------- subscriptions ----------
function isSubscribed(userId) {
  const s = data.subscriptions[userId];
  if (!s) return false;
  return s.until === 0 || s.until > Date.now();
}

function grant(userId, days) {
  const until = days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : 0;
  data.subscriptions[userId] = { until, grantedAt: Date.now() };
  save();
}

function revoke(userId) {
  delete data.subscriptions[userId];
  save();
}

// ---------- bans ----------
function isBanned(userId) {
  return Boolean(data.banned[userId]);
}

function setBanned(userId, value) {
  if (value) data.banned[userId] = Date.now();
  else delete data.banned[userId];
  save();
}

// ---------- groups ----------
function upsertGroup(chat, status) {
  const title = chat.title || String(chat.id);
  const active = !['left', 'kicked'].includes(status);
  const g = data.groups[chat.id];
  if (g && g.title === title && g.active === active) return;
  data.groups[chat.id] = {
    id: chat.id,
    title,
    active,
    addedAt: g ? g.addedAt : Date.now(),
  };
  save();
}

// ---------- challenges ----------
function addChallenge(record) {
  data.challenges.push(record);
  save();
}

function challengesOf(chatId) {
  return data.challenges.filter((c) => String(c.chatId) === String(chatId));
}

module.exports = {
  data,
  upsertUser,
  isSubscribed,
  grant,
  revoke,
  isBanned,
  setBanned,
  upsertGroup,
  addChallenge,
  challengesOf,
};
