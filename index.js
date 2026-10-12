'use strict';

/* =====================================================================
   Telegram Challenge Bot - نسخه ۴
   ---------------------------------------------------------------------
   - توکن فقط از متغیر محیطی BOT_TOKEN خوانده می‌شود.
   - پنل مدیریت، اشتراک، بن، آمار کامل گروه‌ها.
   - ۶ بازی: بسکتبال، فوتبال، تاس، بولینگ، دارت، کازینو.
   - ادمین: تعداد برنده، مدت زمان (یا پایان دستی).
   - امتیاز لحظه‌ای با ریپلای روی پیام کاربر.
   - پیام برنده برای هر نفر و جدول نفرات ۱ تا ۵ در پایان.
   ===================================================================== */

const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');

/* =====================================================================
   ۱) تنظیمات
   ===================================================================== */

const TOKEN = '8931143472:AAGUeeBhjIg0gNW4ljbQZCc5YBESLdrYhVY';

const OWNER_ID = Number(process.env.OWNER_ID || 8942987641);
const PORT = Number(process.env.PORT || 10000);
// اگر تلگرام رنگ دکمه‌ها را نشان نداد، در Render متغیر COLORED_BUTTONS=off بگذارید
const COLORED_BUTTONS = process.env.COLORED_BUTTONS !== 'off';

if (!TOKEN) {
  console.error('BOT_TOKEN is not set. Add it in Render Environment variables.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
let BOT_USERNAME = '';

/* =====================================================================
   ۲) وضعیت در حافظه
   ===================================================================== */

const inputState = new Map(); // ورودی متنی مالک در انتظار
const setups = new Map();     // chatId -> چالشی که ادمین در حال تنظیم است
const sessions = new Map();   // chatId -> چالش در حال اجرا

/* =====================================================================
   ۳) بازی‌ها و قوانین امتیازدهی
   ---------------------------------------------------------------------
   scoring:
     goal  -> گل زدن. هر گل (مقدار در goalValues) = ۱ امتیاز.
              بیشترین امتیاز برنده است؛ تساوی با زودتر بودن حل می‌شود.
     exact -> الگو. فقط کسی که دقیقاً الگو (عدد یا ست) را بیاورد امتیاز می‌گیرد.
              برندگان بر اساس زودترین ثبت انتخاب می‌شوند.
     rank  -> امتیاز = عدد خروجی تلگرام. بیشترین عدد برنده است.
   ===================================================================== */

const GAMES = {
  basketball: {
    emoji: '🏀',
    name: 'بسکتبال',
    scoring: 'goal',
    goalValues: [4, 5],
    unit: 'گل',
    rules:
      '• توپ را داخل حلقه بیندازید.\n' +
      '• هر گل <b>۱ امتیاز</b> دارد.\n' +
      '• بیشترین امتیاز برنده است؛ در تساوی، زودترین شوت برنده است.\n' +
      '• هر نفر فقط <b>یک بار</b> شوت می‌زند.',
  },
  football: {
    emoji: '⚽',
    name: 'فوتبال',
    scoring: 'goal',
    goalValues: [3, 4, 5],
    unit: 'گل',
    rules:
      '• توپ را به دروازه بزنید.\n' +
      '• هر گل <b>۱ امتیاز</b> دارد.\n' +
      '• بیشترین امتیاز برنده است؛ در تساوی، زودترین شوت برنده است.\n' +
      '• هر نفر فقط <b>یک بار</b> شوت می‌زند.',
  },
  dice: {
    emoji: '🎲',
    name: 'تاس',
    scoring: 'exact',
    rules:
      '• ادمین یک عدد (۱ تا ۶) را به عنوان <b>الگو</b> انتخاب می‌کند.\n' +
      '• هرکس دقیقاً همان عدد را بیاورد برنده است.\n' +
      '• برندگان بر اساس زودترین ثبت انتخاب می‌شوند.\n' +
      '• هر نفر فقط <b>یک بار</b> تاس می‌اندازد.',
  },
  bowling: {
    emoji: '🎳',
    name: 'بولینگ',
    scoring: 'rank',
    rules:
      '• عدد <b>۶</b> یعنی <b>استرایک</b> (همه کیل‌ها افتاده‌اند).\n' +
      '• امتیاز شما همان عدد خروجی است؛ بیشترین امتیاز برنده است.\n' +
      '• در تساوی، زودتر شوت زده برنده است.\n' +
      '• هر نفر فقط <b>یک بار</b> شوت می‌زند.',
  },
  darts: {
    emoji: '🎯',
    name: 'دارت',
    scoring: 'rank',
    rules:
      '• عدد <b>۶</b> یعنی <b>بول</b> (وسط تخته).\n' +
      '• امتیاز شما همان عدد خروجی است؛ بیشترین امتیاز برنده است.\n' +
      '• در تساوی، زودتر پرتاب کرده برنده است.\n' +
      '• هر نفر فقط <b>یک بار</b> پرتاب می‌کند.',
  },
  casino: {
    emoji: '🎰',
    name: 'کازینو',
    scoring: 'exact',
    rules:
      '• ادمین یک <b>ست</b> را انتخاب می‌کند: ۷۷۷، لیمو، BAR، انگور یا رندوم.\n' +
      '• هرکس دقیقاً همان ست را بیاورد برنده است.\n' +
      '• در حالت رندوم، ادمین یک 🎰 می‌فرستد و همان عدد الگو می‌شود.\n' +
      '• برندگان بر اساس زودترین ثبت انتخاب می‌شوند.',
  },
};

// ست‌های کازینو (نگاشت جامعه: 1=BAR، 22=انگور، 43=لیمو، 64=777)
const SLOT_SETS = {
  seven: { label: '🎰 ست 777', value: 64 },
  lemon: { label: '🍋 ست لیمو', value: 43 },
  bar: { label: '🔴 ست BAR', value: 1 },
  grape: { label: '🍇 ست انگور', value: 22 },
  random: { label: '🔀 ست رندوم', value: null },
};
const SLOT_NAMES = { 64: '777 🎰', 43: 'لیمو 🍋', 22: 'انگور 🍇', 1: 'BAR 🔴' };

// مدت زمان‌های قابل انتخاب توسط ادمین (ثانیه). 0 = پایان دستی
const DURATIONS = [
  { sec: 30, label: '30 ثانیه' },
  { sec: 60, label: '1 دقیقه' },
  { sec: 120, label: '2 دقیقه' },
  { sec: 180, label: '3 دقیقه' },
  { sec: 300, label: '5 دقیقه' },
  { sec: 0, label: 'پایان دستی توسط ادمین' },
];

const ADMIN_RE = /^(menu:|sub:|ban:|stats:|groups:|quick:)/;
const EMPTY_KB = { inline_keyboard: [] };

/* =====================================================================
   ۴) کمکی‌ها
   ===================================================================== */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// رنگ دکمه: success = سبز، danger = قرمز، primary = آبی
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
const durLabel = (sec) => (sec === 0 ? 'پایان دستی' : `${sec} ثانیه`);

function stripStyles(extra) {
  if (!extra || !extra.reply_markup) return extra;
  const rm = JSON.parse(JSON.stringify(extra.reply_markup));
  rm.inline_keyboard = rm.inline_keyboard.map((row) => row.map(({ style, ...rest }) => rest));
  return { ...extra, reply_markup: rm };
}

// ارسال مطمئن: اگر با HTML یا رنگ شکست خورد، نسخه ساده را می‌فرستد
async function sendSafe(chatId, text, extra = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
  } catch (e) {
    console.error('sendSafe failed, retrying plain:', e.message);
    try {
      return await bot.sendMessage(chatId, text.replace(/<[^>]+>/g, ''), stripStyles(extra));
    } catch (e2) {
      console.error('sendSafe plain failed:', e2.message);
      return null;
    }
  }
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
    if (/not modified/i.test(e.message)) return null;
    console.error('show failed, sending new message:', e.message);
    return sendSafe(chatId, text, { reply_markup: markup });
  }
}

function notifyUser(userId, text) {
  return sendSafe(userId, text).catch(() => {});
}

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

/* =====================================================================
   ۵) منوها
   ===================================================================== */

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
    [B('📖 قوانین همه بازی‌ها', 'ch:rules')],
    [R('🔴 لغو تنظیمات / چالش فعال', 'ch:cancel')],
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

const durationMenu = () =>
  kb([
    [G('⏱ 30 ثانیه', 'du:30'), G('⏱ 1 دقیقه', 'du:60')],
    [B('⏱ 2 دقیقه', 'du:120'), B('⏱ 3 دقیقه', 'du:180')],
    [B('⏱ 5 دقیقه', 'du:300')],
    [R('✋ پایان دستی توسط ادمین', 'du:0')],
    [B('🔙 بازگشت', 'ch:menu')],
  ]);

const liveControls = () =>
  kb([
    [R('⏹ پایان همین الان', 'live:end')],
    [B('📊 وضعیت فعلی', 'live:status')],
  ]);

/* =====================================================================
   ۶) متن‌های ادمین
   ===================================================================== */

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

/* =====================================================================
   ۷) برچسب نتیجه هر بازیکن
   ===================================================================== */

function resultLabel(game, p) {
  switch (game) {
    case 'basketball':
    case 'football':
      return p.score ? `${p.score} گل` : 'بدون گل';
    case 'dice':
      return `عدد ${p.value}`;
    case 'casino':
      return SLOT_NAMES[p.value] || `کد ${p.value}`;
    case 'bowling':
      return p.value === 6 ? `استرایک (${p.value})` : `${p.value} از ۶`;
    case 'darts':
      return p.value === 6 ? `بول (${p.value})` : `${p.value} از ۶`;
    default:
      return `امتیاز ${p.value}`;
  }
}

/* =====================================================================
   ۸) آمار گروه
   ===================================================================== */

function groupStatsText(chatId) {
  const g = db.data.groups[chatId];
  const list = db.challengesOf(chatId);

  const perGame = {};
  const winsAll = {};
  const winsByGame = {};
  const playsAll = {};
  const diceTargets = {};
  const casinoSets = {};

  for (const c of list) {
    perGame[c.game] = (perGame[c.game] || 0) + 1;
    if (c.game === 'dice' && c.target) diceTargets[c.target] = (diceTargets[c.target] || 0) + 1;
    if (c.game === 'casino' && c.target) casinoSets[c.target] = (casinoSets[c.target] || 0) + 1;

    for (const w of c.winners || []) {
      winsAll[w.id] = { name: w.name, count: (winsAll[w.id] ? winsAll[w.id].count : 0) + 1 };
      winsByGame[c.game] = winsByGame[c.game] || {};
      const cur = winsByGame[c.game][w.id];
      winsByGame[c.game][w.id] = { name: w.name, count: (cur ? cur.count : 0) + 1 };
    }
    for (const p of c.results || []) {
      playsAll[p.id] = { name: p.name, count: (playsAll[p.id] ? playsAll[p.id].count : 0) + 1 };
    }
  }

  const topWinners = Object.entries(winsAll).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  const topPlayers = Object.entries(playsAll).sort((a, b) => b[1].count - a[1].count).slice(0, 5);

  let text = `📊 <b>آمار گروه ${esc(g ? g.title : chatId)}</b>\n`;
  text += `🎮 کل چالش‌های برگزار شده: <b>${list.length}</b>\n\n`;

  text += '🏆 <b>نفرات برتر (بیشترین برد)</b>\n';
  text += topWinners.length
    ? topWinners.map(([id, v], i) => `${i + 1}. ${userLink(id, v.name)} — ${v.count} برد`).join('\n')
    : 'هنوز برنده‌ای ثبت نشده.';

  text += '\n\n👥 <b>پرکارترین شرکت‌کنندگان</b>\n';
  text += topPlayers.length
    ? topPlayers.map(([id, v], i) => `${i + 1}. ${userLink(id, v.name)} — ${v.count} شرکت`).join('\n')
    : 'هنوز شرکت‌کننده‌ای ثبت نشده.';

  text += '\n\n🎯 <b>آمار هر بازی و قهرمان آن</b>\n';
  const gameKeys = Object.keys(GAMES);
  for (const key of gameKeys) {
    const count = perGame[key] || 0;
    const champ = winsByGame[key]
      ? Object.entries(winsByGame[key]).sort((a, b) => b[1].count - a[1].count)[0]
      : null;
    text += `• ${GAMES[key].emoji} ${GAMES[key].name}: ${count} بار`;
    text += champ ? ` | 🏅 قهرمان: ${userLink(champ[0], champ[1].name)} (${champ[1].count} برد)\n` : '\n';
  }

  if (Object.keys(diceTargets).length) {
    text += '\n🎲 <b>الگوهای تاس استفاده شده</b>\n';
    text += Object.entries(diceTargets).map(([n, c]) => `• عدد ${n}: ${c} بار`).join('\n') + '\n';
  }
  if (Object.keys(casinoSets).length) {
    text += '\n🎰 <b>ست‌های کازینو استفاده شده</b>\n';
    text += Object.entries(casinoSets)
      .map(([v, c]) => `• ${SLOT_NAMES[v] || 'کد ' + v}: ${c} بار`)
      .join('\n') + '\n';
  }

  text += '\n📜 <b>آخرین ۸ چالش</b>\n';
  const recent = list.slice(-8).reverse();
  text += recent.length
    ? recent
        .map((c) => {
          const game = GAMES[c.game] ? GAMES[c.game].name : c.game;
          const winners = (c.winners || []).length
            ? c.winners.map((w) => `${esc(w.name)} (<code>${w.id}</code>)`).join('، ')
            : 'بدون برنده';
          return `• ${fmtDate(c.date)} | ${game} | شرکت‌کننده: ${c.participants} | برنده: ${winners}`;
        })
        .join('\n')
    : 'چالشی ثبت نشده.';
  return text;
}

/* =====================================================================
   ۹) پیام‌های خصوصی
   ===================================================================== */

async function sendHome(chatId, uid) {
  if (isOwner(uid)) {
    return sendSafe(chatId, ADMIN_TEXT, { reply_markup: adminMenu() });
  }
  if (db.isBanned(uid)) {
    return sendSafe(chatId, '⛔️ دسترسی شما توسط مدیریت مسدود شده است.');
  }
  if (!db.isSubscribed(uid)) {
    return sendSafe(
      chatId,
      '🔒 برای استفاده از ربات نیاز به اشتراک دارید.\nبرای خرید روی دکمه زیر بزنید تا درخواست شما به مالک ارسال شود.',
      { reply_markup: buyMenu() }
    );
  }
  return sendSafe(
    chatId,
    '✅ اشتراک شما فعال است.\nربات را به گروه اضافه و ادمین کنید، سپس در گروه دستور /challenge را بزنید.',
    {
      reply_markup: kb([
        [{ text: '🟢 افزودن ربات به گروه', url: `https://t.me/${BOT_USERNAME}?startgroup=true`, style: COLORED_BUTTONS ? 'success' : undefined }],
      ]),
    }
  );
}

async function requestSubscription(q) {
  const uid = q.from.id;
  if (db.isSubscribed(uid)) return sendSafe(uid, '✅ اشتراک شما از قبل فعال است.');
  const info =
    '📩 <b>درخواست اشتراک جدید</b>\n' +
    `نام: ${userLink(uid, fullName(q.from))}\n` +
    `آیدی: <code>${uid}</code>\n` +
    `یوزرنیم: ${q.from.username ? '@' + esc(q.from.username) : 'ندارد'}`;
  await sendSafe(OWNER_ID, info, {
    reply_markup: kb([
      [G('🟢 ۳۰ روز', `quick:add:${uid}:30`), G('🟢 نامحدود', `quick:add:${uid}:0`)],
      [R('🔴 رد درخواست', `quick:no:${uid}`)],
    ]),
  });
  return sendSafe(uid, '✅ درخواست شما برای مالک ارسال شد. پس از تایید، اشتراک فعال می‌شود.');
}

async function onPrivate(msg) {
  const uid = msg.from.id;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (isOwner(uid) && inputState.has(uid) && text) {
    return onOwnerInput(msg, inputState.get(uid), text);
  }
  if (text === '/cancel') {
    inputState.delete(uid);
    return sendSafe(chatId, 'عملیات لغو شد.');
  }
  return sendHome(chatId, uid);
}

async function onOwnerInput(msg, st, text) {
  const chatId = msg.chat.id;

  if (text === '/cancel') {
    inputState.delete(OWNER_ID);
    return sendSafe(chatId, 'لغو شد.', { reply_markup: adminMenu() });
  }

  const num = Number(text);
  if (st.type.endsWith('_id') && (!Number.isInteger(num) || num <= 0)) {
    return sendSafe(chatId, '❌ آیدی عددی معتبر بفرستید (یا /cancel).');
  }

  switch (st.type) {
    case 'sub_add_id':
      inputState.set(OWNER_ID, { type: 'sub_add_days', userId: num });
      return sendSafe(chatId, 'تعداد روز اشتراک را بفرستید (۰ = نامحدود):');

    case 'sub_add_days': {
      if (!Number.isInteger(num) || num < 0) return sendSafe(chatId, '❌ عدد معتبر بفرستید (۰ یا بیشتر).');
      db.grant(st.userId, num);
      inputState.delete(OWNER_ID);
      notifyUser(st.userId, `🟢 اشتراک شما فعال شد (${subLabel(num)}). برای شروع /start را بزنید.`);
      return sendSafe(chatId, `🟢 اشتراک ${subLabel(num)} برای <code>${st.userId}</code> فعال شد.`, {
        reply_markup: adminMenu(),
      });
    }

    case 'sub_del_id':
      db.revoke(num);
      inputState.delete(OWNER_ID);
      notifyUser(num, '🔴 اشتراک شما لغو شد.');
      return sendSafe(chatId, `🔴 اشتراک <code>${num}</code> حذف شد.`, { reply_markup: adminMenu() });

    case 'ban_add_id':
      db.setBanned(num, true);
      db.revoke(num);
      inputState.delete(OWNER_ID);
      return sendSafe(chatId, `🚫 کاربر <code>${num}</code> بن شد.`, { reply_markup: adminMenu() });

    case 'ban_del_id':
      db.setBanned(num, false);
      inputState.delete(OWNER_ID);
      return sendSafe(chatId, `🟢 بن کاربر <code>${num}</code> برداشته شد.`, { reply_markup: adminMenu() });

    default:
      inputState.delete(OWNER_ID);
      return sendHome(chatId, OWNER_ID);
  }
}

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
      return sendSafe(chatId, 'آیدی عددی کاربر را بفرستید (یا /cancel):');
    case 'sub:del':
      inputState.set(OWNER_ID, { type: 'sub_del_id' });
      return sendSafe(chatId, 'آیدی عددی کاربری که اشتراکش حذف شود را بفرستید (یا /cancel):');
    case 'sub:list':
      return show(chatId, mid, subListText(), backKb());
    case 'ban:add':
      inputState.set(OWNER_ID, { type: 'ban_add_id' });
      return sendSafe(chatId, 'آیدی عددی کاربری که بن شود را بفرستید (یا /cancel):');
    case 'ban:del':
      inputState.set(OWNER_ID, { type: 'ban_del_id' });
      return sendSafe(chatId, 'آیدی عددی کاربری که آن‌بن شود را بفرستید (یا /cancel):');
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

/* =====================================================================
   ۱۰) منطق امتیاز و رتبه‌بندی
   ===================================================================== */

// امتیاز یک انتخاب بر اساس قانون بازی
function scoreFor(session, value) {
  const g = GAMES[session.game];
  if (g.scoring === 'goal') return g.goalValues.includes(value) ? 1 : 0;
  if (g.scoring === 'exact') return value === session.target ? 1 : 0;
  return value; // rank
}

// رتبه‌بندی لحظه‌ای و نهایی
function rankPlayers(session) {
  const g = GAMES[session.game];
  const list = [...session.players.values()];
  if (g.scoring === 'exact') {
    return list.filter((p) => p.score === 1).sort((a, b) => a.time - b.time);
  }
  if (g.scoring === 'goal') {
    return list.filter((p) => p.score > 0).sort((a, b) => b.score - a.score || a.time - b.time);
  }
  return list.sort((a, b) => b.value - a.value || a.time - b.time);
}

// متن امتیاز لحظه‌ای که زیر پیام کاربر ریپلای می‌شود
function liveText(session, p, pos) {
  const g = GAMES[session.game];
  let res;
  switch (session.game) {
    case 'basketball':
    case 'football':
      res = p.score ? `🥅 گل! +۱ امتیاز` : '❌ گل نشد (۰ امتیاز)';
      break;
    case 'dice':
      res = p.score
        ? `✅ عدد ${p.value} — الگو درست بود!`
        : `❌ عدد ${p.value} آمد؛ الگو ${esc(session.label)} نبود`;
      break;
    case 'casino':
      res = p.score
        ? `✅ ${SLOT_NAMES[p.value] || p.value} — الگو درست بود!`
        : `❌ ${SLOT_NAMES[p.value] || 'کد ' + p.value} آمد؛ الگو نبود`;
      break;
    case 'bowling':
      res = p.value === 6 ? `🎳 استرایک! امتیاز ${p.value}` : `🎳 امتیاز ${p.value} از ۶`;
      break;
    case 'darts':
      res = p.value === 6 ? `🎯 بول! امتیاز ${p.value}` : `🎯 امتیاز ${p.value} از ۶`;
      break;
    default:
      res = `امتیاز ${p.value}`;
  }
  const posText = pos ? `🏅 رتبه فعلی شما: ${pos}` : 'ℹ️ فعلاً خارج از برندگان';
  return `${g.emoji} <b>${esc(p.name)}</b>\n${res}\n⏱ زمان ثبت: ${p.elapsed.toFixed(2)} ثانیه از شروع\n${posText}`;
}

/* =====================================================================
   ۱۱) چالش: شروع، زنده، پایان
   ===================================================================== */

function clearSession(chatId) {
  const s = sessions.get(chatId);
  if (!s) return null;
  for (const t of s.timers) clearTimeout(t);
  sessions.delete(chatId);
  return s;
}

async function startChallenge(chatId, setup) {
  const g = GAMES[setup.game];
  const session = {
    chatId,
    game: setup.game,
    emoji: g.emoji,
    target: setup.target,
    label: setup.label || '',
    winners: setup.winners,
    durationSec: setup.durationSec,
    adminId: setup.adminId,
    players: new Map(),
    startedAt: Date.now(),
    timers: [],
  };
  sessions.set(chatId, session);

  if (session.durationSec > 0) {
    const total = session.durationSec * 1000;
    if (total > 20000) {
      session.timers.push(setTimeout(() => sendSafe(chatId, `⏳ نصف زمان گذشت! هنوز می‌توانید ${g.emoji} بفرستید.`), total / 2));
    }
    if (total > 15000) {
      session.timers.push(setTimeout(() => sendSafe(chatId, '⚠️ ۱۰ ثانیه تا پایان چالش مانده است!'), total - 10000));
    }
    session.timers.push(
      setTimeout(() => finishChallenge(chatId, 'time').catch((e) => console.error('finish error:', e)), total)
    );
  }

  let rulesShort = g.rules;
  if (g.scoring === 'exact') rulesShort = `🎯 الگو: <b>${esc(session.label)}</b>\n` + rulesShort;

  return sendSafe(
    chatId,
    `🏁 <b>چالش ${g.emoji} ${g.name} شروع شد</b>\n` +
      `👥 تعداد برنده: <b>${session.winners}</b>\n` +
      `⏱ مدت: <b>${durLabel(session.durationSec)}</b>\n\n` +
      `📖 <b>قوانین و امتیازدهی:</b>\n${rulesShort}\n\n` +
      `ایموجی ${g.emoji} را بفرستید تا امتیازتان ثبت و به پیامتان پاسخ داده شود.`,
    { reply_markup: liveControls() }
  );
}

function winnerText(session, p, rank, challengeId) {
  const g = GAMES[session.game];
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  const uname = p.username ? `@${esc(p.username)}` : 'بدون یوزرنیم';
  return (
    `🏆 <b>تبریک ${esc(p.name)}! شما برنده شدید</b> ${medals[rank - 1] || '🏅'}\n\n` +
    `🎮 بازی: ${g.emoji} ${g.name}\n` +
    `🔢 رتبه: <b>${rank}</b>\n` +
    `📊 نتیجه: <b>${resultLabel(session.game, p)}</b>\n` +
    `⏱ زمان ثبت: ${p.elapsed.toFixed(2)} ثانیه از شروع\n` +
    `🆔 آیدی: <code>${p.id}</code> | ${uname}\n` +
    `📅 تاریخ: ${fmtDate(p.time)}\n` +
    `🔖 کد چالش: <code>${esc(challengeId)}</code>`
  );
}

async function finishChallenge(chatId, reason = 'manual') {
  const s = clearSession(chatId);
  if (!s) return;

  const g = GAMES[s.game];
  const ranked = rankPlayers(s);
  const winners = ranked.slice(0, s.winners);
  const top5 = ranked.slice(0, 5);
  const endedAt = Date.now();
  const challengeId = `${chatId}-${endedAt}`;
  const group = db.data.groups[chatId];

  db.addChallenge({
    id: challengeId,
    chatId,
    chatTitle: group ? group.title : String(chatId),
    game: s.game,
    date: endedAt,
    startedAt: s.startedAt,
    durationSec: s.durationSec,
    endReason: reason,
    participants: s.players.size,
    target: s.target,
    label: s.label,
    winnersCount: s.winners,
    winners: winners.map((p) => ({ id: p.id, name: p.name, username: p.username, value: p.value, score: p.score, elapsed: p.elapsed })),
    top5: top5.map((p) => ({ id: p.id, name: p.name, value: p.value, score: p.score })),
    results: [...s.players.values()].map((p) => ({ id: p.id, name: p.name, value: p.value, score: p.score, elapsed: p.elapsed })),
  });

  const reasonText = reason === 'time' ? '⏱ زمان چالش تمام شد' : '✋ توسط ادمین پایان یافت';

  if (!winners.length) {
    return sendSafe(
      chatId,
      `⏹ چالش ${g.emoji} ${g.name} بدون برنده پایان یافت.\n${reasonText}\n👥 شرکت‌کنندگان: ${s.players.size}\n🔖 کد چالش: <code>${challengeId}</code>`
    );
  }

  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  const summary =
    `🏁 <b>پایان چالش ${g.emoji} ${g.name}</b>\n` +
    `${reasonText}\n` +
    `📅 تاریخ: ${fmtDate(endedAt)}\n` +
    (s.label ? `🎯 الگو: ${esc(s.label)}\n` : '') +
    `👥 کل شرکت‌کنندگان: ${s.players.size} | 🏆 تعداد برنده: ${s.winners}\n` +
    `🔖 کد چالش: <code>${challengeId}</code>\n\n` +
    `<b>📊 نفرات ۱ تا ۵:</b>\n` +
    top5
      .map((p, i) => `${medals[i]} ${userLink(p.id, p.name)} — ${resultLabel(s.game, p)} (${p.elapsed.toFixed(2)}s)`)
      .join('\n') +
    `\n\n<b>🎉 برندگان:</b> ${winners.map((p) => userLink(p.id, p.name)).join('، ')}`;

  await sendSafe(chatId, summary);

  // پیام اختصاصی برای هر برنده، ریپلای روی پیام خودش
  for (let i = 0; i < winners.length; i++) {
    const p = winners[i];
    await sendSafe(chatId, winnerText(s, p, i + 1, challengeId), { reply_to_message_id: p.msgId });
  }
}

/* =====================================================================
   ۱۲) دریافت ایموجی اعضا
   ===================================================================== */

function handleDice(msg) {
  const chatId = msg.chat.id;
  const user = msg.from;
  const d = msg.dice;
  if (!user || user.is_bot) return;

  // الگوی رندوم کازینو: فقط ادمین انتخاب‌کننده می‌تواند الگو را بفرستد
  const setup = setups.get(chatId);
  if (setup && setup.waitTemplate && user.id === setup.adminId && d.emoji === '🎰') {
    setup.target = d.value;
    setup.label = `🔀 ست رندوم (${SLOT_NAMES[d.value] || 'کد ' + d.value})`;
    setup.waitTemplate = false;
    return sendSafe(chatId, `✅ الگو ثبت شد: <b>${esc(setup.label)}</b>\n🏆 تعداد برنده را انتخاب کنید:`, {
      reply_markup: winnersMenu(),
    });
  }

  const s = sessions.get(chatId);
  if (!s || d.emoji !== s.emoji) return;

  if (s.players.has(user.id)) {
    return sendSafe(chatId, '⚠️ شما قبلاً شرکت کرده‌اید؛ هر نفر فقط یک بار مجاز است.', {
      reply_to_message_id: msg.message_id,
    });
  }

  const now = Date.now();
  const p = {
    id: user.id,
    name: fullName(user),
    username: user.username || null,
    value: d.value,
    score: scoreFor(s, d.value),
    time: now,
    elapsed: (now - s.startedAt) / 1000,
    msgId: msg.message_id,
  };
  s.players.set(user.id, p);

  const ranked = rankPlayers(s);
  const pos = ranked.findIndex((x) => x.id === user.id) + 1;
  return sendSafe(chatId, liveText(s, p, pos), { reply_to_message_id: msg.message_id });
}

/* =====================================================================
   ۱۳) کلیک‌های گروه
   ===================================================================== */

async function onGroupCallback(q) {
  const d = q.data || '';
  const chatId = q.message.chat.id;
  const uid = q.from.id;
  const mid = q.message.message_id;

  if (!(await canManageChallenge(chatId, uid))) {
    return bot.answerCallbackQuery(q.id, { text: '⛔️ فقط ادمین گروه با اشتراک فعال', show_alert: true }).catch(() => {});
  }
  await bot.answerCallbackQuery(q.id).catch(() => {});

  // ---- کنترل چالش در حال اجرا ----
  if (d === 'live:end') {
    if (!sessions.has(chatId)) return sendSafe(chatId, 'ℹ️ چالش فعالی وجود ندارد.');
    return finishChallenge(chatId, 'manual');
  }

  if (d === 'live:status') {
    const s = sessions.get(chatId);
    if (!s) return sendSafe(chatId, 'ℹ️ چالش فعالی وجود ندارد.');
    const ranked = rankPlayers(s).slice(0, 5);
    const lines = ranked.length
      ? ranked.map((p, i) => `${i + 1}. ${esc(p.name)} — ${resultLabel(s.game, p)} (${p.elapsed.toFixed(2)}s)`).join('\n')
      : 'هنوز امتیازی ثبت نشده.';
    return sendSafe(
      chatId,
      `📊 <b>وضعیت فعلی ${GAMES[s.game].emoji} ${GAMES[s.game].name}</b>\n` +
        `👥 شرکت‌کنندگان: ${s.players.size}\n\n${lines}`
    );
  }

  if (d === 'ch:menu') return show(chatId, mid, CHALLENGE_TEXT, challengeMenu());

  if (d === 'ch:rules') {
    const lines = Object.values(GAMES).map((g) => `${g.emoji} <b>${g.name}</b>\n${g.rules}`);
    return sendSafe(chatId, '📖 <b>قوانین و امتیازدهی شش بازی</b>\n\n' + lines.join('\n\n'));
  }

  if (d === 'ch:cancel') {
    const s = clearSession(chatId);
    setups.delete(chatId);
    if (!s) return sendSafe(chatId, 'ℹ️ تنظیمات یا چالش فعالی وجود ندارد.');
    return sendSafe(chatId, '🔴 چالش فعال لغو شد. امتیازهای ثبت‌شده ذخیره نشدند.');
  }

  if (d.startsWith('ch:')) {
    const game = d.slice(3);
    if (!GAMES[game]) return;
    if (sessions.has(chatId)) {
      return sendSafe(chatId, '⏳ یک چالش در حال اجراست. ابتدا آن را تمام یا لغو کنید.');
    }
    setups.set(chatId, { game, adminId: uid, target: null, label: '', waitTemplate: false, winners: 0, durationSec: 0 });

    if (game === 'casino') return show(chatId, mid, '🎰 یک ست کازینو انتخاب کنید:', casinoMenu());
    if (game === 'dice') return show(chatId, mid, '🎲 عدد الگوی تاس را انتخاب کنید:', diceMenu());
    return show(chatId, mid, `🏆 تعداد برنده ${GAMES[game].emoji} ${GAMES[game].name} را انتخاب کنید:`, winnersMenu());
  }

  if (d.startsWith('dc:')) {
    const setup = setups.get(chatId);
    if (!setup || setup.game !== 'dice') return sendSafe(chatId, '❌ ابتدا بازی تاس را از پنل انتخاب کنید.');
    setup.target = Number(d.slice(3));
    setup.label = `🎲 عدد ${setup.target}`;
    return show(chatId, mid, `✅ ${setup.label} انتخاب شد.\n🏆 تعداد برنده را انتخاب کنید:`, winnersMenu());
  }

  if (d.startsWith('cs:')) {
    const setup = setups.get(chatId);
    if (!setup || setup.game !== 'casino') return sendSafe(chatId, '❌ ابتدا بازی کازینو را از پنل انتخاب کنید.');
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
        '🎰 حالا یک <b>ایموجی کازینو 🎰</b> از داخل گروه بفرستید تا الگو شود.\n(فقط همین ادمین می‌تواند الگو را بفرستد)',
        EMPTY_KB
      );
    }

    setup.target = set.value;
    setup.label = set.label;
    return show(chatId, mid, `✅ ${set.label} انتخاب شد.\n🏆 تعداد برنده را انتخاب کنید:`, winnersMenu());
  }

  // ادمین تعداد برنده را انتخاب می‌کند
  if (d.startsWith('win:')) {
    const setup = setups.get(chatId);
    if (!setup) return sendSafe(chatId, '❌ تنظیمات پیدا نشد. دوباره از /challenge شروع کنید.');
    const g = GAMES[setup.game];
    if (g.scoring === 'exact' && setup.target === null) {
      return sendSafe(chatId, '❌ ابتدا الگو را مشخص کنید.');
    }
    setup.winners = Number(d.slice(4));
    return show(chatId, mid, `✅ ${setup.winners} برنده ثبت شد.\n⏱ مدت زمان چالش را انتخاب کنید:`, durationMenu());
  }

  // ادمین مدت زمان را انتخاب می‌کند و چالش شروع می‌شود
  if (d.startsWith('du:')) {
    const setup = setups.get(chatId);
    if (!setup || !setup.winners) return sendSafe(chatId, '❌ تنظیمات پیدا نشد. دوباره از /challenge شروع کنید.');
    if (sessions.has(chatId)) return sendSafe(chatId, '⏳ یک چالش در حال اجراست.');

    setup.durationSec = Number(d.slice(3));
    setups.delete(chatId);
    await show(chatId, mid, `✅ چالش ${GAMES[setup.game].emoji} ${GAMES[setup.game].name} تنظیم و شروع شد.`, EMPTY_KB);
    return startChallenge(chatId, setup);
  }
}

/* =====================================================================
   ۱۴) پیام‌های گروه
   ===================================================================== */

async function onGroup(msg) {
  const chatId = msg.chat.id;
  const uid = msg.from ? msg.from.id : null;

  db.upsertGroup(msg.chat, 'member');

  if (msg.dice) return handleDice(msg);

  const text = (msg.text || '').trim();
  if (/^\/(challenge|panel)(@\S+)?$/i.test(text)) {
    if (!uid || !(await canManageChallenge(chatId, uid))) {
      return sendSafe(chatId, 'این دستور فقط برای ادمین گروه با اشتراک فعال است.', {
        reply_to_message_id: msg.message_id,
      });
    }
    return sendSafe(chatId, CHALLENGE_TEXT, { reply_markup: challengeMenu() });
  }
}

/* =====================================================================
   ۱۵) رویدادها
   ===================================================================== */

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
    if (q.message && q.message.chat.type !== 'private') {
      sendSafe(q.message.chat.id, `❌ خطا در اجرای دستور: ${esc(e.message)}`);
    }
  }
});

bot.on('my_chat_member', (update) => {
  const chat = update.chat;
  if (chat.type === 'private') return;
  const status = update.new_chat_member.status;
  db.upsertGroup(chat, status);
  if (['left', 'kicked'].includes(status)) {
    clearSession(chat.id);
    setups.delete(chat.id);
  }
});

bot.on('polling_error', (e) => {
  console.error('polling_error:', e.code || '', e.message);
});

/* =====================================================================
   ۱۶) راه‌اندازی
   ===================================================================== */

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
