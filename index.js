
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
    if (err) console.error('🚫 Не удалось записать в лог-файл:', err.message);
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
const activeWatchers = new Map(); // key: wallet, value: { ws, label }

setInterval(() => {
  const pingMsg = '📡 Global ping';
  console.log(pingMsg);
  logToFile(pingMsg);
}, 180000);

// Команды управления
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (chatId === PUBLIC_CHAT_ID) return;
  bot.sendMessage(chatId, '👋 Управление слежением', {
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
  if (list.length === 0) {
    bot.sendMessage(chatId, '📭 Активных слежений нет.');
  } else {
    const formatted = list.map(([addr, meta]) => `${meta.label}: ${addr}`).join('\n');
    bot.sendMessage(chatId, `📋 Отслеживаемые адреса:
<code>${formatted}</code>`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/delete/, (msg) => {
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
    if (list.length === 0) {
      bot.sendMessage(chatId, '📭 Активных слежений нет.');
    } else {
      const buttons = list.map(([addr, meta]) => ([{ text: `❌ ${meta.label}: ${addr}`, callback_data: `delete_${addr}` }]));
      bot.sendMessage(chatId, '📋 Активные адреса:', {
        reply_markup: {
          inline_keyboard: [...buttons, [{ text: '🧹 Удалить все', callback_data: 'delete_all' }]]
        }
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
      bot.sendMessage(chatId, `❌ Слежение за <code>${meta.label}: ${wallet}</code> остановлено.`, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(chatId, `⚠️ Адрес <code>${wallet}</code> не отслеживается.`, { parse_mode: 'HTML' });
    }
  }
});

bot.on('polling_error', (error) => {
  const errMsg = `🐛 Polling Error: ${error.message}`;
  console.error(errMsg);
  logToFile(errMsg);
  logToTelegram(errMsg);
});

bot.on('message', (msg) => {
  try {
    const text = msg.text;
    const senderId = msg.chat.id;
    if (!text || senderId !== PUBLIC_CHAT_ID) return;

    logToFile(`📨 Incoming message: ${text}`);
    logToTelegram(`Incoming message: ${text}`);

    let label = null;
    if (text.includes('Кук-3') && text.includes('68.99')) {
      label = 'Кук-3';
    } else if (text.includes('Кук-1') && text.includes('99.99')) {
      label = 'Кук-1';
    } else return;

    let wallet = null;
    const linkMatch = text.match(/solscan\.io\/account\/(\w{32,44})/);
    if (linkMatch) {
      wallet = linkMatch[1];
    } else if (msg.entities) {
      const entity = msg.entities.find(e => e.type === 'text_link' && e.url?.includes('solscan.io/account/'));
      const match = entity?.url?.match(/account\/(\w{32,44})/);
      wallet = match?.[1];
    }

    if (!wallet) return;

    const notifyMsg = `⚠️ [${label}] Обнаружен перевод ${label === 'Кук-3' ? '68.99' : '99.99'} SOL\n💰 Адрес: <code>${wallet}</code>\n⏳ Ожидаем mint...`;
    bot.sendMessage(PRIVATE_CHAT_ID, notifyMsg, { parse_mode: 'HTML' });
    logToFile(notifyMsg);
    logToTelegram(notifyMsg);

    watchMint(wallet, label);

  } catch (err) {
    const errorMsg = `🧨 Error in message handler: ${err.message}`;
    console.error(errorMsg);
    logToFile(errorMsg);
    logToTelegram(errorMsg);
  }
});

function watchMint(wallet, label) {
  const ws = new WebSocket(`wss://rpc.helius.xyz/?api-key=${HELIUS_KEY}`);
  activeWatchers.set(wallet, { ws, label });

  const timeout = setTimeout(() => {
    const timeoutMsg = `⌛ [${label}] Mint не обнаружен за 20 ч.\n🕳 ${wallet}`;
    bot.sendMessage(PRIVATE_CHAT_ID, timeoutMsg, { parse_mode: 'HTML' });
    logToFile(timeoutMsg);
    logToTelegram(timeoutMsg);
    ws.close();
    activeWatchers.delete(wallet);
  }, 20 * 60 * 60 * 1000);

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      const ping = `📡 [${label}] Ping для ${wallet}`;
      console.log(ping);
      logToFile(ping);
    }
  }, 180000);

  ws.on('open', () => {
    const openMsg = `✅ [${label}] Слежение за ${wallet}`;
    console.log(openMsg);
    logToFile(openMsg);
    logToTelegram(openMsg);
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [wallet] },
        { commitment: 'confirmed', encoding: 'jsonParsed' }
      ]
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const logs = msg?.params?.result?.value?.logs || [];
      const sig = msg?.params?.result?.value?.signature;
      const mentions = msg?.params?.result?.value?.mentions || [];

      if (!sig || seenSignatures.has(sig)) return;
      const found = logs.find(log => log.includes('InitializeMint') || log.includes('InitializeMint2'));
      if (!found) return;

      const mintAddress = mentions?.[0] || 'неизвестен';
      seenSignatures.add(sig);

      clearTimeout(timeout);
      clearInterval(pingInterval);

      const mintMsg = `✅ [${label}] Mint обнаружен!\n🧾 Контракт: <code>${mintAddress}</code>`;
      bot.sendMessage(PRIVATE_CHAT_ID, mintMsg, { parse_mode: 'HTML' });
      logToFile(mintMsg);
      logToTelegram(mintMsg);

      ws.close();
      activeWatchers.delete(wallet);
    } catch (e) {
      const errMsg = `⚠️ Ошибка обработки WebSocket: ${e.message}`;
      console.error(errMsg);
      logToFile(errMsg);
      logToTelegram(errMsg);
    }
  });

  ws.on('close', () => {
    const closeMsg = `❌ [${label}] WebSocket закрыт для ${wallet}`;
    console.log(closeMsg);
    logToFile(closeMsg);
    clearInterval(pingInterval);
    activeWatchers.delete(wallet);
  });

  ws.on('error', (e) => {
    const errMsg = `💥 WebSocket error: ${e.message}`;
    console.error(errMsg);
    logToFile(errMsg);
    logToTelegram(errMsg);
    clearInterval(pingInterval);
    ws.close();
    activeWatchers.delete(wallet);
  });
}
