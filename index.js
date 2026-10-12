'use strict';

const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

// ---------- config ----------
const TOKEN = 'توکن_ربات_خود_را_اینجا_بگذارید';
const OWNER_ID = Number(process.env.OWNER_ID || 8942987641);
const PORT = Number(process.env.PORT || 10000);
const CHALLENGE_SECONDS = Number(process.env.CHALLENGE_SECONDS || 120);

if (!TOKEN) {
  console.error('BOT_TOKEN is not set.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
let BOT_USERNAME = '';

// ---------- in-memory state ----------
const inputState = new Map(); // owner pending text input
const setups = new Map();     // chatId -> challenge being prepared
const sessions = new Map();   // chatId -> running challenge

// ---------- games ----------
// امتیاز تاس‌های تلگرام: 🏀⚽ 1-5، 🎲🎳🎯 1-6، 🎰 1-64
// نگاشت 🎰 (طبق مستندات جامعه): 1=BAR، 22=انگور، 43=لیمو، 64=777
const GAMES = {
  basketball: { emoji: '🏀', name: 'بسکتبال' },
  football: { emoji: '⚽', name: 'فوتبال' },
  dice: { emoji: '🎲', name: 'تاس' },
  bowling: { emoji: '🎳', name: 'بولینگ' },
  darts: { emoji: '🎯', name: 'دارت' },
  casino: { emoji: '🎰', name: 'کازینو' },
};

const SLOT_SETS = {
  seven: { label: '🟢 ست 777', value: 64 },
  lemon: { label: '🟡 ست لیمو 🍋', value: 43 },
  bar: { label: '🔴 ست BAR', value: 1 },
  grape: { label: '🟢 ست انگور 🍇', value: 22 },
  random: { label: '🟡 ست رندوم 🔀', value: null },
};

const ADMIN_RE = /^(menu:|sub:|ban:|stats:|groups:|quick:)/;
const EMPTY_KB = { inline_keyboard: [] };

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const btn = (text, data) => ({ text, callback_data: data });
const kb = (rows) => ({ inline_keyboard: rows });
const userLink = (id, name) => `<a href="tg://user?id=${id}">${esc(name)}</a>`;
const isOwner = (id) => Number(id) === OWNER_ID;
const canUse = (id) => !db.isBanned(id) && (isOwner(id) || db.isSubscribed(id));
const fullName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id);
const fmtDate = (ts) => new Date(ts).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
const subLabel = (days) => (days === 0 ? 'نامحدود' : `${days} روزه`);

async function isGroupAdmin(chatId, uid) {
  try {
    const m = await bot.getChatMember(chatId, uid);
    return ['creator', 'administrator'].includes(m.status);
  } catch (e) {
    return false;
  }
}

async function canManageChallenge(chatId, uid) {
  if (!canUse(uid)) return false;
  if (isOwner(uid)) return true;
  return isGroupAdmin(chatId, uid);
}

async function show(chatId, mid, text, markup) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: mid,
      parse_mode: 'HTML',
      reply_markup: markup,
    });
  } catch (e) {
    if (/not modified/i.test(e.message)) return;
    return bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: markup });
  }
}

function notifyUser(userId, text) {
  return bot.sendMessage(userId, text, { parse_mode: 'HTML' }).catch(() => {});
}

// ---------- menus ----------
const ADMIN_TEXT = '👑 <b>پنل مدیریت</b>\nیکی از گزینه‌ها را انتخاب کنید.';
const CHALLENGE_TEXT = '🎮 <b>پنل چالش‌ها</b>\nیک بازی را انتخاب کنید.';

const adminMenu = () =>
  kb([
    [btn('🟢 افزودن اشتراک', 'sub:add'), btn('🔴 حذف اشتراک', 'sub:del')],
    [btn('🟡 لیست اشتراک‌ها', 'sub:list')],
    [btn('🔴 بن کاربر', 'ban:add'), btn('🟢 آن‌بن کاربر', 'ban:del')],
    [btn('🟡 لیست بن‌ها', 'ban:list')],
    [btn('🟡 آمار گروه‌ها', 'stats:groups'), btn('🟡 لیست گروه‌ها', 'groups:list')],
  ]);

const backKb = () => kb([[btn('🔙 بازگشت', 'menu:admin')]]);

const buyMenu = () =>
  kb([
    [btn('🟢 درخواست خرید اشتراک', 'req:sub')],
    [{ text: '🟡 تماس مستقیم با مالک', url: `tg://user?id=${OWNER_ID}` }],
  ]);

const challengeMenu = () =>
  kb([
    [btn('🏀 بسکتبال', 'ch:basketball'), btn('⚽ فوتبال', 'ch:football')],
    [btn('🎲 تاس', 'ch:dice'), btn('🎳 بولینگ', 'ch:bowling')],
    [btn('🎯 دارت', 'ch:darts'), btn('🎰 کازینو', 'ch:casino')],
    [btn('🔴 لغو چالش فعال', 'ch:cancel')],
  ]);

const casinoMenu = () =>
  kb([
    [btn('🟢 ست 777', 'cs:seven'), btn('🟡 ست لیمو', 'cs:lemon')],
    [btn('🔴 ست BAR', 'cs:bar'), btn('🟢 ست انگور', 'cs:grape')],
    [btn('🟡 ست رندوم', 'cs:random')],
    [btn('🔙 بازگشت', 'ch:menu')],
  ]);

const winnersMenu = () =>
  kb([
    [btn('1 نفر', 'win:1'), btn('2 نفر', 'win:2'), btn('3 نفر', 'win:3')],
    [btn('5 نفر', 'win:5'), btn('10 نفر', 'win:10')],
    [btn('🔙 بازگشت', 'ch:menu')],
  ]);

// ---------- admin text builders ----------
function subListText() {
  const entries = Object.entries(db.data.subscriptions);
  if (!entries.length) return '📋 هیچ اشتراکی ثبت نشده است.';
  const lines = entries.slice(0, 50).map(([id, s]) => {
    let status;
    if (s.until === 0) status = 'نامحدود';
    else if (s.until > Date.now()) status = `تا ${fmtDate(s.until)}`;
    else status = 'منقضی';
    return `• <code>${id}</code> — ${status}`;
  });
  return '📋 <b>لیست اشتراک‌ها</b>\n' + lines.join('\n');
}

function banListText() {
  const ids = Object.keys(db.data.banned);
  if (!ids.length) return '📋 هیچ کاربر بن‌شده‌ای وجود ندارد.';
  return '🚫 <b>کاربران بن‌شده</b>\n' + ids.map((id) => `• <code>${id}</code>`).join('\n');
}

function groupsListText() {
  const groups = Object.values(db.data.groups);
  if (!groups.length) return '📋 ربات هنوز در گروهی ثبت نشده است.';
  return (
    '🏢 <b>گروه‌های ربات</b>\n' +
    groups
      .map((g) => `• ${esc(g.title)} (<code>${g.id}</code>) ${g.active ? '🟢' : '🔴'}`)
      .join('\n')
  );
}

function groupStatsText(chatId) {
  const g = db.data.groups[chatId];
  const list = db.challengesOf(chatId);
  const wins = {};
  for (const c of list) {
    for (const w of c.winners) {
      wins[w.id] = { name: w.name, count: (wins[w.id] ? wins[w.id].count : 0) + 1 };
    }
  }
  const top = Object.entries(wins)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);
  const recent = list.slice(-8).reverse();

  let text = `📊 <b>آمار گروه ${esc(g ? g.title : chatId)}</b>\n`;
  text += `🎮 تعداد چالش‌های برگزار شده: ${list.length}\n\n`;
  text += '🏆 <b>نفرات برتر</b>\n';
  text += top.length
    ? top.map(([id, v], i) => `${i + 1}. ${userLink(id, v.name)} — ${v.count} برد`).join('\n')
    : 'هنوز برنده‌ای ثبت نشده.';
  text += '\n\n📜 <b>آخرین چالش‌ها</b>\n';
  text += recent.length
    ? recent
        .map((c) => {
          const game = GAMES[c.game] ? GAMES[c.game].name : c.game;
          const winners = c.winners.length
            ? c.winners.map((w) => `${esc(w.name)} (<code>${w.id}</code>)`).join('، ')
            : 'بدون برنده';
          return `• ${fmtDate(c.date)} | ${game} | شرکت‌کننده: ${c.participants} | برنده: ${winners}`;
        })
        .join('\n')
    : 'چالشی ثبت نشده.';
  return text;
}

// ---------- start / menus for users ----------
async function sendHome(chatId, uid) {
  if (isOwner(uid)) {
    return bot.sendMessage(chatId, ADMIN_TEXT, { parse_mode: 'HTML', reply_markup: adminMenu() });
  }
  if (db.isBanned(uid)) {
    return bot.sendMessage(chatId, '⛔️ دسترسی شما توسط مدیریت مسدود شده است.');
  }
  if (!db.isSubscribed(uid)) {
    return bot.sendMessage(
      chatId,
      '🔒 برای استفاده از ربات نیاز به اشتراک دارید.\nبرای خرید روی دکمه زیر بزنید تا درخواست شما به مالک ارسال شود.',
      { reply_markup: buyMenu() }
    );
  }
  return bot.sendMessage(
    chatId,
    `✅ اشتراک شما فعال است.\nربات را به گروه اضافه کنید و ادمین کنید، سپس در گروه دستور /challenge را بزنید.`,
    {
      reply_markup: kb([[{ text: '➕ افزودن ربات به گروه', url: `https://t.me/${BOT_USERNAME}?startgroup=true` }]]),
    }
  );
}

async function requestSubscription(q) {
  const uid = q.from.id;
  if (db.isSubscribed(uid)) {
    return bot.sendMessage(uid, '✅ اشتراک شما از قبل فعال است.');
  }
  const info =
    `📩 <b>درخواست اشتراک جدید</b>\n` +
    `نام: ${userLink(uid, fullName(q.from))}\n` +
    `آیدی: <code>${uid}</code>\n` +
    `یوزرنیم: ${q.from.username ? '@' + esc(q.from.username) : 'ندارد'}`;
  await bot.sendMessage(OWNER_ID, info, {
    parse_mode: 'HTML',
    reply_markup: kb([
      [btn('🟢 ۳۰ روز', `quick:add:${uid}:30`), btn('🟢 نامحدود', `quick:add:${uid}:0`)],
      [btn('🔴 رد درخواست', `quick:no:${uid}`)],
    ]),
  });
  return bot.sendMessage(uid, '✅ درخواست شما برای مالک ارسال شد. پس از تایید، اشتراک فعال می‌شود.');
}

// ---------- private messages ----------
async function onPrivate(msg) {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (isOwner(uid) && inputState.has(uid) && text) {
    return onOwnerInput(msg, inputState.get(uid), text);
  }
  if (text === '/start' || text === '/menu' || text === '/admin') {
    return sendHome(chatId, uid);
  }
  if (text === '/cancel') {
    inputState.delete(uid);
    return bot.sendMessage(chatId, 'عملیات لغو شد.');
  }
  if (!isOwner(uid)) {
    return sendHome(chatId, uid);
  }
  return sendHome(chatId, uid);
}

async function onOwnerInput(msg, st, text) {
  const chatId = msg.chat.id;

  if (text === '/cancel') {
    inputState.delete(OWNER_ID);
    return bot.sendMessage(chatId, 'لغو شد.', { reply_markup: adminMenu() });
  }

  const num = Number(text);
  if (st.type.endsWith('_id') && (!Number.isInteger(num) || num <= 0)) {
    return bot.sendMessage(chatId, '❌ آیدی عددی معتبر بفرستید (یا /cancel).');
  }

  switch (st.type) {
    case 'sub_add_id':
      inputState.set(OWNER_ID, { type: 'sub_add_days', userId: num });
      return bot.sendMessage(chatId, 'تعداد روز اشتراک را بفرستید (۰ = نامحدود):');

    case 'sub_add_days': {
      if (!Number.isInteger(num) || num < 0) {
        return bot.sendMessage(chatId, '❌ عدد معتبر بفرستید (۰ یا بیشتر).');
      }
      db.grant(st.userId, num);
      inputState.delete(OWNER_ID);
      notifyUser(st.userId, `🟢 اشتراک شما فعال شد (${subLabel(num)}). برای شروع /start را بزنید.`);
      return bot.sendMessage(chatId, `🟢 اشتراک ${subLabel(num)} برای <code>${st.userId}</code> فعال شد.`, {
        parse_mode: 'HTML',
        reply_markup: adminMenu(),
      });
    }

    case 'sub_del_id':
      db.revoke(num);
      inputState.delete(OWNER_ID);
      notifyUser(num, '🔴 اشتراک شما لغو شد.');
      return bot.sendMessage(chatId, `🔴 اشتراک <code>${num}</code> حذف شد.`, {
        parse_mode: 'HTML',
        reply_markup: adminMenu(),
      });

    case 'ban_add_id':
      db.setBanned(num, true);
      db.revoke(num);
      inputState.delete(OWNER_ID);
      return bot.sendMessage(chatId, `🚫 کاربر <code>${num}</code> بن شد.`, {
        parse_mode: 'HTML',
        reply_markup: adminMenu(),
      });

    case 'ban_del_id':
      db.setBanned(num, false);
      inputState.delete(OWNER_ID);
      return bot.sendMessage(chatId, `🟢 بن کاربر <code>${num}</code> برداشته شد.`, {
        parse_mode: 'HTML',
        reply_markup: adminMenu(),
      });

    default:
      inputState.delete(OWNER_ID);
      return sendHome(chatId, OWNER_ID);
  }
}

// ---------- private callbacks ----------
async function onPrivateCallback(q) {
  const d = q.data || '';
  const uid = q.from.id;
  const chatId = q.message.chat.id;
  const mid = q.message.message_id;

  if (ADMIN_RE.test(d) && !isOwner(uid)) {
    return bot.answerCallbackQuery(q.id, { text: '⛔️ فقط مالک', show_alert: true }).catch(() => {});
  }
  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (d === 'req:sub') return requestSubscription(q);

  if (d.startsWith('quick:add:')) {
    const [, , targetStr, daysStr] = d.split(':');
    const target = Number(targetStr);
    const days = Number(daysStr);
    db.grant(target, days);
    notifyUser(target, `🟢 اشتراک شما فعال شد (${subLabel(days)}). برای شروع /start را بزنید.`);
    return show(chatId, mid, `🟢 اشتراک ${subLabel(days)} برای <code>${target}</code> فعال شد.`, adminMenu());
  }

  if (d.startsWith('quick:no:')) {
    const target = Number(d.split(':')[2]);
    notifyUser(target, '❌ درخواست اشتراک شما رد شد.');
    return show(chatId, mid, `❌ درخواست <code>${target}</code> رد شد.`, adminMenu());
  }

  switch (d) {
    case 'menu:admin':
      inputState.delete(OWNER_ID);
      return show(chatId, mid, ADMIN_TEXT, adminMenu());

    case 'sub:add':
      inputState.set(OWNER_ID, { type: 'sub_add_id' });
      return bot.sendMessage(chatId, 'آیدی عددی کاربر را بفرستید (یا /cancel):');

    case 'sub:del':
      inputState.set(OWNER_ID, { type: 'sub_del_id' });
      return bot.sendMessage(chatId, 'آیدی عددی کاربری که اشتراکش حذف شود را بفرستید (یا /cancel):');

    case 'sub:list':
      return show(chatId, mid, subListText(), backKb());

    case 'ban:add':
      inputState.set(OWNER_ID, { type: 'ban_add_id' });
      return bot.sendMessage(chatId, 'آیدی عددی کاربری که بن شود را بفرستید (یا /cancel):');

    case 'ban:del':
      inputState.set(OWNER_ID, { type: 'ban_del_id' });
      return bot.sendMessage(chatId, 'آیدی عددی کاربری که آن‌بن شود را بفرستید (یا /cancel):');

    case 'ban:list':
      return show(chatId, mid, banListText(), backKb());

    case 'groups:list':
      return show(chatId, mid, groupsListText(), backKb());

    case 'stats:groups': {
      const groups = Object.values(db.data.groups).slice(0, 30);
      if (!groups.length) return show(chatId, mid, 'ربات هنوز در گروهی نیست.', backKb());
      const rows = groups.map((g) => [btn(`${g.title}`.slice(0, 40), `stats:g:${g.id}`)]);
      rows.push([btn('🔙 بازگشت', 'menu:admin')]);
      return show(chatId, mid, '🏢 گروه مورد نظر را برای دیدن آمار انتخاب کنید:', kb(rows));
    }

    default:
      if (d.startsWith('stats:g:')) {
        const gid = d.slice('stats:g:'.length);
        return show(chatId, mid, groupStatsText(gid), kb([[btn('🔙 لیست گروه‌ها', 'stats:groups')]]));
      }
  }
}

// ---------- group challenge logic ----------
async function startChallenge(chatId, setup, winners) {
  const g = GAMES[setup.game];
  const session = {
    chatId,
    game: setup.game,
    emoji: g.emoji,
    target: setup.target,
    label: setup.label || null,
    winners,
    players: new Map(),
    startedAt: Date.now(),
    timer: null,
  };
  session.timer = setTimeout(() => {
    finishChallenge(chatId).catch((e) => console.error('finish error:', e));
  }, CHALLENGE_SECONDS * 1000);
  sessions.set(chatId, session);

  const rule =
    setup.game === 'casino'
      ? `🎯 ${session.label} (کد ${session.target})`
      : '🏆 بیشترین امتیاز برنده است';

  return bot.sendMessage(
    chatId,
    `🏁 <b>چالش ${g.emoji} ${g.name} شروع شد</b>\n` +
      `👥 تعداد برنده: ${winners}\n` +
      `${rule}\n` +
      `⏱ مهلت: ${CHALLENGE_SECONDS} ثانیه\n\n` +
      `هرکس ${g.emoji} بفرستد شرکت می‌کند (فقط یک بار).`,
    { parse_mode: 'HTML' }
  );
}

async function finishChallenge(chatId) {
  const s = sessions.get(chatId);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(chatId);

  const g = GAMES[s.game];
  const list = [...s.players.values()];
  let winners;
  if (s.game === 'casino') {
    winners = list
      .filter((p) => p.value === s.target)
      .sort((a, b) => a.time - b.time)
      .slice(0, s.winners);
  } else {
    winners = list
      .slice()
      .sort((a, b) => b.value - a.value || a.time - b.time)
      .slice(0, s.winners);
  }

  const group = db.data.groups[chatId];
  db.addChallenge({
    id: `${chatId}-${Date.now()}`,
    chatId,
    chatTitle: group ? group.title : String(chatId),
    game: s.game,
    date: Date.now(),
    participants: list.length,
    target: s.target,
    winners: winners.map((p) => ({ id: p.id, name: p.name, value: p.value })),
  });

  if (!winners.length) {
    return bot.sendMessage(chatId, `⏹ چالش ${g.emoji} ${g.name} بدون برنده پایان یافت.`);
  }

  const lines = winners.map((p, i) => `${i + 1}. ${userLink(p.id, p.name)} (امتیاز: ${p.value})`);
  return bot.sendMessage(
    chatId,
    `🏆 <b>برندگان چالش ${g.emoji} ${g.name}</b>\n\n${lines.join('\n')}\n\n👥 کل شرکت‌کنندگان: ${list.length}`,
    { parse_mode: 'HTML' }
  );
}

function handleDice(msg) {
  const chatId = msg.chat.id;
  const user = msg.from;
  const d = msg.dice;
  if (!user || user.is_bot) return;

  // الگوی کازینوی رندوم: فقط ادمینی که انتخاب کرده می‌تواند بفرستد
  const setup = setups.get(chatId);
  if (setup && setup.waitTemplate && user.id === setup.adminId && d.emoji === '🎰') {
    setup.target = d.value;
    setup.waitTemplate = false;
    return bot.sendMessage(chatId, `✅ الگو ثبت شد (کد ${d.value}).\n🏆 تعداد برنده را انتخاب کنید:`, {
      reply_markup: winnersMenu(),
    });
  }

  const s = sessions.get(chatId);
  if (!s || d.emoji !== s.emoji || s.players.has(user.id)) return;
  s.players.set(user.id, { id: user.id, name: fullName(user), value: d.value, time: Date.now() });
}

async function onGroupCallback(q) {
  const d = q.data || '';
  const chatId = q.message.chat.id;
  const uid = q.from.id;
  const mid = q.message.message_id;

  if (!(await canManageChallenge(chatId, uid))) {
    return bot.answerCallbackQuery(q.id, { text: '⛔️ فقط ادمین گروه با اشتراک فعال', show_alert: true }).catch(() => {});
  }
  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (d === 'ch:menu') return show(chatId, mid, CHALLENGE_TEXT, challengeMenu());

  if (d === 'ch:cancel') {
    const s = sessions.get(chatId);
    if (!s) return bot.sendMessage(chatId, 'ℹ️ چالش فعالی وجود ندارد.');
    clearTimeout(s.timer);
    sessions.delete(chatId);
    return bot.sendMessage(chatId, '🔴 چالش فعال لغو شد.');
  }

  if (d.startsWith('ch:')) {
    const game = d.slice(3);
    if (!GAMES[game]) return;
    if (sessions.has(chatId)) {
      return bot.sendMessage(chatId, '⏳ یک چالش در حال اجراست. ابتدا آن را تمام یا لغو کنید.');
    }
    if (game === 'casino') {
      setups.set(chatId, { game: 'casino', adminId: uid, target: null, label: null, waitTemplate: false });
      return show(chatId, mid, '🎰 یک ست کازینو انتخاب کنید:', casinoMenu());
    }
    setups.set(chatId, { game, adminId: uid, target: null, label: null, waitTemplate: false });
    return show(chatId, mid, `🏆 تعداد برنده ${GAMES[game].emoji} ${GAMES[game].name} را انتخاب کنید:`, winnersMenu());
  }

  if (d.startsWith('cs:')) {
    const setup = setups.get(chatId);
    if (!setup || setup.game !== 'casino') return;
    const key = d.slice(3);
    const set = SLOT_SETS[key];
    if (!set) return;

    if (key === 'random') {
      setup.waitTemplate = true;
      setup.adminId = uid;
      setup.target = null;
      setup.label = set.label;
      return show(
        chatId,
        mid,
        '🎰 حالا یک <b>کازینو 🎰</b> از داخل گروه بفرستید تا الگو شود.\n(فقط همین ادمین می‌تواند الگو بفرستد)',
        EMPTY_KB
      );
    }

    setup.target = set.value;
    setup.label = set.label;
    return show(chatId, mid, `✅ ${set.label} انتخاب شد.\n🏆 تعداد برنده را انتخاب کنید:`, winnersMenu());
  }

  if (d.startsWith('win:')) {
    const setup = setups.get(chatId);
    if (!setup) return bot.sendMessage(chatId, '❌ ابتدا بازی را انتخاب کنید.');
    if (setup.game === 'casino' && setup.target === null) {
      return bot.sendMessage(chatId, '❌ ابتدا ست کازینو را مشخص کنید.');
    }
    if (sessions.has(chatId)) return bot.sendMessage(chatId, '⏳ یک چالش در حال اجراست.');

    const winners = Number(d.slice(4));
    setups.delete(chatId);
    await show(chatId, mid, '✅ تنظیمات ثبت شد.', EMPTY_KB);
    return startChallenge(chatId, setup, winners);
  }
}

// ---------- group messages ----------
async function onGroup(msg) {
  const chatId = msg.chat.id;
  const uid = msg.from ? msg.from.id : null;

  db.upsertGroup(msg.chat, 'member');

  if (msg.dice) return handleDice(msg);

  const text = (msg.text || '').trim();
  if (/^\/(challenge|panel)(@\S+)?$/i.test(text)) {
    if (!uid || !(await canManageChallenge(chatId, uid))) {
      return bot.sendMessage(chatId, 'این دستور فقط برای ادمین گروه با اشتراک فعال است.', {
        reply_to_message_id: msg.message_id,
      }).catch(() => {});
    }
    return bot.sendMessage(chatId, CHALLENGE_TEXT, {
      parse_mode: 'HTML',
      reply_markup: challengeMenu(),
    });
  }
}

// ---------- event wiring ----------
bot.on('message', async (msg) => {
  try {
    if (msg.from) db.upsertUser(msg.from);
    if (msg.chat.type === 'private') return await onPrivate(msg);
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') return await onGroup(msg);
  } catch (e) {
    console.error('message error:', e);
  }
});

bot.on('callback_query', async (q) => {
  try {
    if (!q.message) return;
    if (q.message.chat.type === 'private') return await onPrivateCallback(q);
    return await onGroupCallback(q);
  } catch (e) {
    console.error('callback error:', e);
  }
});

bot.on('my_chat_member', (update) => {
  const chat = update.chat;
  if (chat.type === 'private') return;
  const status = update.new_chat_member.status;
  db.upsertGroup(chat, status);
  if (['left', 'kicked'].includes(status)) {
    const s = sessions.get(chat.id);
    if (s) {
      clearTimeout(s.timer);
      sessions.delete(chat.id);
    }
    setups.delete(chat.id);
  }
});

bot.on('polling_error', (e) => {
  console.error('polling_error:', e.code || '', e.message);
});

// ---------- startup ----------
bot
  .getMe()
  .then((me) => {
    BOT_USERNAME = me.username;
    console.log(`Bot started as @${BOT_USERNAME}`);
  })
  .catch((e) => console.error('getMe failed:', e.message));

// Render به یک پورت HTTP نیاز دارد؛ این سرور فقط برای health check است.
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot is running');
  })
  .listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));
