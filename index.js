'use strict';

const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

// ---------- config (فقط از محیط خوانده می‌شود، هرگز داخل کد ننویسید) ----------
const TOKEN = ;8931143472:AAGUeeBhjIg0gNW4ljbQZCc5YBESLdrYhVY;
const OWNER_ID = Number(process.env.OWNER_ID || 8942987641);
const PORT = Number(process.env.PORT || 10000);
const CHALLENGE_SECONDS = Number(process.env.CHALLENGE_SECONDS || 120);
// اگر تلگرام رنگ دکمه‌ها را نشان نداد، در Render مقدار COLORED_BUTTONS=off بگذارید
const COLORED_BUTTONS = process.env.COLORED_BUTTONS !== 'off';

if (!TOKEN) {
  console.error('BOT_TOKEN is not set. Add it in Render Environment variables.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
let BOT_USERNAME = '';

// ---------- in-memory state ----------
const inputState = new Map(); // ورودی متنی مالک در انتظار
const setups = new Map();     // chatId -> چالشی که ادمین در حال تنظیم آن است
const sessions = new Map();   // chatId -> چالش در حال اجرا

// ---------- بازی‌ها ----------
// mode:
//   goal  -> گل زدن (امتیاز ۱ یا ۰)، برنده با بیشترین امتیاز
//   rank  -> رتبه بر اساس عدد تاس، بیشترین عدد برنده است
//   exact -> الگو: فقط کسانی که دقیقاً عدد الگو را بیاورند برنده‌اند
const GAMES = {
  basketball: { emoji: '🏀', name: 'بسکتبال', mode: 'goal' },
  football: { emoji: '⚽', name: 'فوتبال', mode: 'goal' },
  dice: { emoji: '🎲', name: 'تاس', mode: 'exact' },
  bowling: { emoji: '🎳', name: 'بولینگ', mode: 'rank' },
  darts: { emoji: '🎯', name: 'دارت', mode: 'rank' },
  casino: { emoji: '🎰', name: 'کازینو', mode: 'exact' },
};

// مقادیری که گل حساب می‌شوند (مطابق مستندات جامعه؛ در صورت نیاز تغییر دهید)
const GOAL_VALUES = {
  basketball: [4, 5],
  football: [3, 4, 5],
};

// نگاشت اسلات 🎰: 1=BAR، 22=انگور، 43=لیمو، 64=777
const SLOT_SETS = {
  seven: { label: '🎰 ست 777', value: 64 },
  lemon: { label: '🍋 ست لیمو', value: 43 },
  bar: { label: '🔴 ست BAR', value: 1 },
  grape: { label: '🍇 ست انگور', value: 22 },
  random: { label: '🔀 ست رندوم', value: null },
};

const ADMIN_RE = /^(menu:|sub:|ban:|stats:|groups:|quick:)/;
const EMPTY_KB = { inline_keyboard: [] };

// ---------- کمکی‌ها ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// رنگ دکمه: success=سبز، danger=قرمز، primary=آبی
const btn = (text, data, color) => {
  const b = { text, callback_data: data };
  if (COLORED_BUTTONS && color) b.style = color;
  return b;
};
const G = (text, data) => btn(text, data, 'success');
const R = (text, data) => btn(text, data, 'danger');
const B = (text, data) => btn(text, data, 'primary');
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

// ---------- منوها ----------
const ADMIN_TEXT = '👑 <b>پنل مدیریت</b>\nیکی از گزینه‌ها را انتخاب کنید.';
const CHALLENGE_TEXT = '🎮 <b>پنل چالش‌ها</b>\nیک بازی را انتخاب کنید.';

const adminMenu = () =>
  kb([
    [G('🟢 افزودن اشتراک', 'sub:add'), R('🔴 حذف اشتراک', 'sub:del')],
    [B('📋 لیست اشتراک‌ها', 'sub:list')],
    [R('🔴 بن کاربر', 'ban:add'), G('🟢 آن‌بن کاربر', 'ban:del')],
    [B('📋 لیست بن‌ها', 'ban:list')],
    [B('📊 آمار گروه‌ها', 'stats:groups'), B('🏢 لیست گروه‌ها', 'groups:list')],
  ]);

const backKb = () => kb([[B('🔙 بازگشت', 'menu:admin')]]);

const buyMenu = () =>
  kb([
    [G('🟢 درخواست خرید اشتراک', 'req:sub')],
    [{ text: '🔵 تماس مستقیم با مالک', url: `tg://user?id=${OWNER_ID}`, style: COLORED_BUTTONS ? 'primary' : undefined }],
  ]);

const challengeMenu = () =>
  kb([
    [B('🏀 بسکتبال', 'ch:basketball'), B('⚽ فوتبال', 'ch:football')],
    [B('🎲 تاس', 'ch:dice'), B('🎳 بولینگ', 'ch:bowling')],
    [B('🎯 دارت', 'ch:darts'), B('🎰 کازینو', 'ch:casino')],
    [R('🔴 لغو چالش فعال', 'ch:cancel')],
  ]);

const casinoMenu = () =>
  kb([
    [G('🎰 ست 777', 'cs:seven'), B('🍋 ست لیمو', 'cs:lemon')],
    [R('🔴 ست BAR', 'cs:bar'), G('🍇 ست انگور', 'cs:grape')],
    [B('🔀 ست رندوم', 'cs:random')],
    [B('🔙 بازگشت', 'ch:menu')],
  ]);

const diceMenu = () =>
  kb([
    [B('1', 'dc:1'), B('2', 'dc:2'), B('3', 'dc:3')],
    [B('4', 'dc:4'), B('5', 'dc:5'), B('6', 'dc:6')],
    [B('🔙 بازگشت', 'ch:menu')],
  ]);

const winnersMenu = () =>
  kb([
    [G('1 نفر', 'win:1'), G('2 نفر', 'win:2'), G('3 نفر', 'win:3')],
    [G('5 نفر', 'win:5'), G('10 نفر', 'win:10')],
    [B('🔙 بازگشت', 'ch:menu')],
  ]);

// ---------- متن‌های ادمین ----------
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
    groups.map((g) => `• ${esc(g.title)} (<code>${g.id}</code>) ${g.active ? '🟢' : '🔴'}`).join('\n')
  );
}

// آمار کامل گروه: کلی + نفرات برتر + آمار اختصاصی هر بازی + تاریخچه
function groupStatsText(chatId) {
  const g = db.data.groups[chatId];
  const list = db.challengesOf(chatId);

  const wins = {};
  const perGame = {};
  const diceTargets = {};
  for (const c of list) {
    perGame[c.game] = (perGame[c.game] || 0) + 1;
    if (c.game === 'dice' && c.target) diceTargets[c.target] = (diceTargets[c.target] || 0) + 1;
    for (const w of c.winners) {
      wins[w.id] = { name: w.name, count: (wins[w.id] ? wins[w.id].count : 0) + 1 };
    }
  }
  const top = Object.entries(wins).sort((a, b) => b[1].count - a[1].count).slice(0, 5);

  let text = `📊 <b>آمار گروه ${esc(g ? g.title : chatId)}</b>\n`;
  text += `🎮 کل چالش‌های برگزار شده: ${list.length}\n\n`;

  text += '🏆 <b>نفرات برتر (بیشترین برد)</b>\n';
  text += top.length
    ? top.map(([id, v], i) => `${i + 1}. ${userLink(id, v.name)} — ${v.count} برد`).join('\n')
    : 'هنوز برنده‌ای ثبت نشده.';

  text += '\n\n🎯 <b>آمار هر بازی</b>\n';
  text += Object.keys(perGame).length
    ? Object.entries(perGame)
        .map(([k, n]) => `• ${GAMES[k] ? GAMES[k].emoji + ' ' + GAMES[k].name : k}: ${n} بار`)
        .join('\n')
    : 'بازی‌ای ثبت نشده.';

  if (Object.keys(diceTargets).length) {
    text += '\n\n🎲 <b>الگوهای تاس استفاده شده</b>\n';
    text += Object.entries(diceTargets)
      .map(([n, c]) => `• عدد ${n}: ${c} بار`)
      .join('\n');
  }

  text += '\n\n📜 <b>آخرین ۸ چالش</b>\n';
  const recent = list.slice(-8).reverse();
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

// ---------- پیام شروع کاربر ----------
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
    '✅ اشتراک شما فعال است.\nربات را به گروه اضافه و ادمین کنید، سپس در گروه دستور /challenge را بزنید.',
    {
      reply_markup: kb([[{ text: '🟢 افزودن ربات به گروه', url: `https://t.me/${BOT_USERNAME}?startgroup=true`, style: COLORED_BUTTONS ? 'success' : undefined }]]),
    }
  );
}

async function requestSubscription(q) {
  const uid = q.from.id;
  if (db.isSubscribed(uid)) return bot.sendMessage(uid, '✅ اشتراک شما از قبل فعال است.');
  const info =
    '📩 <b>درخواست اشتراک جدید</b>\n' +
    `نام: ${userLink(uid, fullName(q.from))}\n` +
    `آیدی: <code>${uid}</code>\n` +
    `یوزرنیم: ${q.from.username ? '@' + esc(q.from.username) : 'ندارد'}`;
  await bot.sendMessage(OWNER_ID, info, {
    parse_mode: 'HTML',
    reply_markup: kb([
      [G('🟢 ۳۰ روز', `quick:add:${uid}:30`), G('🟢 نامحدود', `quick:add:${uid}:0`)],
      [R('🔴 رد درخواست', `quick:no:${uid}`)],
    ]),
  });
  return bot.sendMessage(uid, '✅ درخواست شما برای مالک ارسال شد. پس از تایید، اشتراک فعال می‌شود.');
}

// ---------- پیام‌های خصوصی ----------
async function onPrivate(msg) {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (isOwner(uid) && inputState.has(uid) && text) {
    return onOwnerInput(msg, inputState.get(uid), text);
  }
  if (text === '/cancel') {
    inputState.delete(uid);
    return bot.sendMessage(chatId, 'عملیات لغو شد.');
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
      if (!Number.isInteger(num) || num < 0) return bot.sendMessage(chatId, '❌ عدد معتبر بفرستید (۰ یا بیشتر).');
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

// ---------- کلیک‌های خصوصی ----------
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
      const rows = groups.map((g) => [B(String(g.title).slice(0, 40), `stats:g:${g.id}`)]);
      rows.push([B('🔙 بازگشت', 'menu:admin')]);
      return show(chatId, mid, '🏢 گروه مورد نظر را برای دیدن آمار انتخاب کنید:', kb(rows));
    }
    default:
      if (d.startsWith('stats:g:')) {
        const gid = d.slice('stats:g:'.length);
        return show(chatId, mid, groupStatsText(gid), kb([[B('🔙 لیست گروه‌ها', 'stats:groups')]]));
      }
  }
}

// ---------- منطق چالش ----------
function scoreOf(session, value) {
  if (session.mode === 'goal') return (GOAL_VALUES[session.game] || []).includes(value) ? 1 : 0;
  return value;
}

// رتبه‌بندی نهایی. زمان بر حسب میلی‌ثانیه است تا در تساوی دقیق باشد.
function rankPlayers(s) {
  const list = [...s.players.values()];
  if (s.mode === 'exact') {
    return list.filter((p) => p.value === s.target).sort((a, b) => a.time - b.time);
  }
  if (s.mode === 'goal') {
    return list.filter((p) => p.score > 0).sort((a, b) => b.score - a.score || a.time - b.time);
  }
  return list.sort((a, b) => b.value - a.value || a.time - b.time);
}

function challengeRules(session) {
  if (session.mode === 'exact') {
    return `🎯 الگو: <b>${session.label}</b>\nهرکس دقیقاً همین عدد را بیاورد برنده است (هر نفر یک بار)`;
  }
  if (session.mode === 'goal') {
    return '⚽🏀 هرکس گل بزند امتیاز می‌گیرد؛ بیشترین امتیاز برنده است (هر نفر یک بار)';
  }
  return '🏆 بیشترین امتیاز برنده است (هر نفر یک بار)';
}

async function startChallenge(chatId, setup, winners) {
  const g = GAMES[setup.game];
  const session = {
    chatId,
    game: setup.game,
    mode: g.mode,
    emoji: g.emoji,
    target: setup.target,
    label: setup.label || '',
    winners,
    players: new Map(),
    startedAt: Date.now(),
    timer: null,
  };
  session.timer = setTimeout(() => {
    finishChallenge(chatId).catch((e) => console.error('finish error:', e));
  }, CHALLENGE_SECONDS * 1000);
  sessions.set(chatId, session);

  return bot.sendMessage(
    chatId,
    `🏁 <b>چالش ${g.emoji} ${g.name} شروع شد</b>\n` +
      `👥 تعداد برنده: ${winners}\n` +
      `${challengeRules(session)}\n` +
      `⏱ مهلت: ${CHALLENGE_SECONDS} ثانیه\n\n` +
      `ایموجی ${g.emoji} را بفرستید تا شرکت کنید.`,
    { parse_mode: 'HTML' }
  );
}

async function finishChallenge(chatId) {
  const s = sessions.get(chatId);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(chatId);

  const g = GAMES[s.game];
  const ranked = rankPlayers(s);
  const winners = ranked.slice(0, s.winners);
  const top5 = ranked.slice(0, 5);
  const group = db.data.groups[chatId];

  db.addChallenge({
    id: `${chatId}-${Date.now()}`,
    chatId,
    chatTitle: group ? group.title : String(chatId),
    game: s.game,
    mode: s.mode,
    date: Date.now(),
    participants: s.players.size,
    target: s.target,
    winners: winners.map((p) => ({ id: p.id, name: p.name, value: p.value })),
    top5: top5.map((p) => ({ id: p.id, name: p.name, value: p.value })),
  });

  if (!winners.length) {
    return bot.sendMessage(chatId, `⏹ چالش ${g.emoji} ${g.name} بدون برنده پایان یافت.`);
  }

  const scoreText = (p) => {
    if (s.mode === 'goal') return `${p.score} گل`;
    if (s.mode === 'exact') return `عدد ${p.value}`;
    if (s.game === 'bowling' && p.value === 6) return `استرایک ${p.value}`;
    return `امتیاز ${p.value}`;
  };

  const winnerLines = winners.map((p, i) => `🥇 ${i + 1}. ${userLink(p.id, p.name)} (${scoreText(p)})`);
  const topLines = top5.map((p, i) => `${i + 1}. ${esc(p.name)} — ${scoreText(p)}`);

  return bot.sendMessage(
    chatId,
    `🏆 <b>نتایج چالش ${g.emoji} ${g.name}</b>\n` +
      `📅 تاریخ: ${fmtDate(Date.now())}\n` +
      `👥 کل شرکت‌کنندگان: ${s.players.size}\n\n` +
      `<b>برندگان:</b>\n${winnerLines.join('\n')}\n\n` +
      `<b>نفرات ۱ تا ۵:</b>\n${topLines.join('\n')}`,
    { parse_mode: 'HTML' }
  );
}

function handleDice(msg) {
  const chatId = msg.chat.id;
  const user = msg.from;
  const d = msg.dice;
  if (!user || user.is_bot) return;

  // الگوی کازینوی رندوم: فقط ادمین انتخاب‌کننده می‌تواند الگو را بفرستد
  const setup = setups.get(chatId);
  if (setup && setup.waitTemplate && user.id === setup.adminId && d.emoji === '🎰') {
    setup.target = d.value;
    setup.label = `🔀 ست رندوم (کد ${d.value})`;
    setup.waitTemplate = false;
    return bot.sendMessage(chatId, `✅ الگو ثبت شد (کد ${d.value}).\n🏆 تعداد برنده را انتخاب کنید:`, {
      reply_markup: winnersMenu(),
    });
  }

  const s = sessions.get(chatId);
  if (!s || d.emoji !== s.emoji || s.players.has(user.id)) return;

  s.players.set(user.id, {
    id: user.id,
    name: fullName(user),
    value: d.value,
    score: scoreOf(s, d.value),
    time: Date.now(),
  });
}

// ---------- کلیک‌های گروه ----------
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
    const base = { game, adminId: uid, target: null, label: '', waitTemplate: false };
    setups.set(chatId, base);

    if (game === 'casino') return show(chatId, mid, '🎰 یک ست کازینو انتخاب کنید:', casinoMenu());
    if (game === 'dice') return show(chatId, mid, '🎲 عدد الگوی تاس را انتخاب کنید:', diceMenu());
    return show(chatId, mid, `🏆 تعداد برنده ${GAMES[game].emoji} ${GAMES[game].name} را انتخاب کنید:`, winnersMenu());
  }

  if (d.startsWith('dc:')) {
    const setup = setups.get(chatId);
    if (!setup || setup.game !== 'dice') return;
    setup.target = Number(d.slice(3));
    setup.label = `🎲 عدد ${setup.target}`;
    return show(chatId, mid, `✅ ${setup.label} انتخاب شد.\n🏆 تعداد برنده را انتخاب کنید:`, winnersMenu());
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
        '🎰 حالا یک <b>ایموجی کازینو 🎰</b> از داخل گروه بفرستید تا الگو شود.\n(فقط همین ادمین می‌تواند الگو بفرستد)',
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
    if (GAMES[setup.game].mode === 'exact' && setup.target === null) {
      return bot.sendMessage(chatId, '❌ ابتدا الگو را مشخص کنید.');
    }
    if (sessions.has(chatId)) return bot.sendMessage(chatId, '⏳ یک چالش در حال اجراست.');

    const winners = Number(d.slice(4));
    setups.delete(chatId);
    await show(chatId, mid, '✅ تنظیمات ثبت شد.', EMPTY_KB);
    return startChallenge(chatId, setup, winners);
  }
}

// ---------- پیام‌های گروه ----------
async function onGroup(msg) {
  const chatId = msg.chat.id;
  const uid = msg.from ? msg.from.id : null;

  db.upsertGroup(msg.chat, 'member');

  if (msg.dice) return handleDice(msg);

  const text = (msg.text || '').trim();
  if (/^\/(challenge|panel)(@\S+)?$/i.test(text)) {
    if (!uid || !(await canManageChallenge(chatId, uid))) {
      return bot
        .sendMessage(chatId, 'این دستور فقط برای ادمین گروه با اشتراک فعال است.', {
          reply_to_message_id: msg.message_id,
        })
        .catch(() => {});
    }
    return bot.sendMessage(chatId, CHALLENGE_TEXT, {
      parse_mode: 'HTML',
      reply_markup: challengeMenu(),
    });
  }
}

// ---------- رویدادها ----------
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

// ---------- راه‌اندازی ----------
bot
  .getMe()
  .then((me) => {
    BOT_USERNAME = me.username;
    console.log(`Bot started as @${BOT_USERNAME}`);
  })
  .catch((e) => console.error('getMe failed:', e.message));

// Render به پورت HTTP نیاز دارد؛ این سرور فقط برای health check است.
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot is running');
  })
  .listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));
