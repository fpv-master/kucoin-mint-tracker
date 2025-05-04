const dotenv = require('dotenv');
dotenv.config();

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');

const logFile = path.join(__dirname, 'logs.txt');
function logToFile(message) {
  const timestamp = new Date().toISOString();
  fs.appendFile(logFile, `[${timestamp}] ${message}\n`, err => {
    if (err) console.error('❌ Ошибка записи в лог-файл:', err.message);
  });
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const PUBLIC_CHAT_ID = Number(process.env.PUBLIC_CHAT_ID);
const PRIVATE_CHAT_ID = Number(process.env.PRIVATE_CHAT_ID);

function logToTelegram(message) {
  bot.sendMessage(PRIVATE_CHAT_ID, `🪵 Лог:\n<code>${message}</code>`, { parse_mode: 'HTML' });
}

const seenSignatures = new Set();
const activeWatchers = new Map();

setInterval(() => {
  const pingMsg = '📡 Global ping';
  console.log(pingMsg);
  logToFile(pingMsg);
}, 180000);

bot.onText(/\/start/, (msg) => {
  if (msg.chat.id === PUBLIC_CHAT_ID) return;
  bot.sendMessage(msg.chat.id, '👋 Панель управления', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Список адресов', callback_data: 'list' }],
        [{ text: '🧹 Удалить все', callback_data: 'delete_all' }]
      ]
    }
  });
});

bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId === PUBLIC_CHAT_ID) return;

  const list = Array.from(activeWatchers.entries());
  if (!list.length) {
    bot.sendMessage(chatId, '📭 Нет активных слежений.');
  } else {
    const formatted = list.map(([wallet, meta]) => `${meta.label}: ${wallet}`).join('\n');
    bot.sendMessage(chatId, `📋 Активные адреса:
<code>${formatted}</code>`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/delete (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (chatId === PUBLIC_CHAT_ID) return;

  const wallet = match[1].trim();
  const meta = activeWatchers.get(wallet);
  if (meta) {
    meta.ws.close();
    activeWatchers.delete(wallet);
    bot.sendMessage(chatId, `❌ Слежение остановлено: <code>${meta.label}: ${wallet}</code>`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(chatId, `⚠️ Адрес <code>${wallet}</code> не отслеживается.`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/delete$/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId === PUBLIC_CHAT_ID) return;

  for (const [wallet, meta] of activeWatchers.entries()) {
    meta.ws.close();
    activeWatchers.delete(wallet);
  }
  bot.sendMessage(chatId, '🧹 Все слежения остановлены.');
});

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === 'list') {
    const list = Array.from(activeWatchers.entries());
    if (!list.length) {
      bot.sendMessage(chatId, '📭 Нет активных адресов.');
    } else {
      const rows = list.map(([addr, meta]) => [{ text: `❌ ${meta.label}: ${addr}`, callback_data: `delete_${addr}` }]);
      bot.sendMessage(chatId, '📋 Активные адреса:', {
        reply_markup: { inline_keyboard: [...rows, [{ text: '🧹 Удалить все', callback_data: 'delete_all' }] ] }
      });
    }
  } else if (data === 'delete_all') {
    for (const [wallet, meta] of activeWatchers.entries()) {
      meta.ws.close();
      activeWatchers.delete(wallet);
    }
    bot.sendMessage(chatId, '🧹 Все слежения остановлены.');
  } else if (data.startsWith('delete_')) {
    const wallet = data.replace('delete_', '');
    const meta = activeWatchers.get(wallet);
    if (meta) {
      meta.ws.close();
      activeWatchers.delete(wallet);
      bot.sendMessage(chatId, `❌ Слежение остановлено: <code>${meta.label}: ${wallet}</code>`, { parse_mode: 'HTML' });
    }
  }
});

bot.on('message', (msg) => {
  try {
    const text = msg.text;
    const senderId = msg.chat.id;
    if (!text || senderId !== PUBLIC_CHAT_ID) return;

    let label = null;
    if (text.includes('Кук-3') && text.includes('68.99')) {
      label = 'Кук-3';
    } else if (text.includes('Кук-1') && text.includes('99.99')) {
      label = 'Кук-1';
    } else return;

    let wallet = null;
    const links = msg.entities?.filter(e => e.type === 'text_link' && e.url?.includes('solscan.io/account/'));
    const last = links?.[links.length - 1];
    const match = last?.url?.match(/account\/(\w{32,44})/);
    wallet = match?.[1];

    if (!wallet) return;

    const logMsg = `⚠️ [${label}] Обнаружен перевод ${label === 'Кук-3' ? '68.99' : '99.99'} SOL\n💰 Адрес: ${wallet}`;
    bot.sendMessage(PRIVATE_CHAT_ID, logMsg, { parse_mode: 'HTML' });
    logToTelegram(logMsg);
    logToFile(logMsg);

    watchMint(wallet, label);
  } catch (err) {
    const errorMsg = `🧨 Ошибка в сообщении: ${err.message}`;
    console.error(errorMsg);
    logToTelegram(errorMsg);
    logToFile(errorMsg);
  }
});

function watchMint(wallet, label) {
  const ws = new WebSocket(`wss://rpc.helius.xyz/?api-key=${HELIUS_KEY}`);
  activeWatchers.set(wallet, { ws, label });

  const timeout = setTimeout(() => {
    const msg = `⌛ [${label}] Mint не обнаружен. Завершено слежение за ${wallet}`;
    bot.sendMessage(PRIVATE_CHAT_ID, msg, { parse_mode: 'HTML' });
    logToFile(msg);
    logToTelegram(msg);
    ws.close();
    activeWatchers.delete(wallet);
  }, 20 * 60 * 60 * 1000);

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log(`📡 [${label}] Ping ${wallet}`);
    }
  }, 180000);

  ws.on('open', () => {
    const openMsg = `✅ [${label}] Слежение начато за ${wallet}`;
    console.log(openMsg);
    logToFile(openMsg);
    logToTelegram(openMsg);
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [{ mentions: [wallet] }, { commitment: 'confirmed', encoding: 'jsonParsed' }]
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const logs = msg?.params?.result?.value?.logs || [];
      const sig = msg?.params?.result?.value?.signature;
      const mentions = msg?.params?.result?.value?.mentions || [];

      if (!sig || seenSignatures.has(sig)) return;
      if (!logs.some(log => log.includes('InitializeMint'))) return;

      const mintAddress = mentions[0] || 'неизвестен';
      seenSignatures.add(sig);
      clearTimeout(timeout);
      clearInterval(pingInterval);

      const mintMsg = `✅ [${label}] Mint выполнен!\n🧾 Контракт: <code>${mintAddress}</code>`;
      bot.sendMessage(PRIVATE_CHAT_ID, mintMsg, { parse_mode: 'HTML' });
      logToFile(mintMsg);
      logToTelegram(mintMsg);

      ws.close();
      activeWatchers.delete(wallet);
    } catch (e) {
      const err = `⚠️ Ошибка WebSocket: ${e.message}`;
      logToTelegram(err);
      logToFile(err);
    }
  });

  ws.on('error', (e) => {
    const err = `💥 WebSocket ошибка: ${e.message}`;
    logToFile(err);
    logToTelegram(err);
    ws.close();
    activeWatchers.delete(wallet);
  });

  ws.on('close', () => {
    const msg = `❌ [${label}] WebSocket закрыт: ${wallet}`;
    console.log(msg);
    logToFile(msg);
    activeWatchers.delete(wallet);
  });
}
