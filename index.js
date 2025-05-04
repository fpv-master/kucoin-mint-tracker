
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
const activeWatchers = new Map();

setInterval(() => {
  const pingMsg = '📡 Global ping';
  console.log(pingMsg);
  logToFile(pingMsg);
  logToTelegram(pingMsg);
}, 180000);

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

    if (text.toLowerCase().includes('список')) {
      const list = Array.from(activeWatchers.keys());
      const reply = list.length
        ? `📋 Сейчас отслеживаются адреса:\n<code>${list.join('\n')}</code>`
        : '📭 Активных слежений нет.';
      bot.sendMessage(PRIVATE_CHAT_ID, reply, { parse_mode: 'HTML' });
      return;
    }

    if (text.toLowerCase().includes('удалить')) {
      for (const [wallet, ws] of activeWatchers.entries()) {
        ws.close();
        activeWatchers.delete(wallet);
      }
      bot.sendMessage(PRIVATE_CHAT_ID, '🧹 Все слежения отключены.');
      return;
    }

    if (!text.includes('Кук-3') || !text.includes('68.99')) return;

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

    const notifyMsg = `⚠️ [Кук-3] Обнаружен перевод 68.99 SOL\n💰 Адрес: <code>${wallet}</code>\n⏳ Ожидаем mint...`;
    bot.sendMessage(PRIVATE_CHAT_ID, notifyMsg, { parse_mode: 'HTML' });
    logToFile(notifyMsg);
    logToTelegram(notifyMsg);

    watchMint(wallet);

  } catch (err) {
    const errorMsg = `🧨 Error in message handler: ${err.message}`;
    console.error(errorMsg);
    logToFile(errorMsg);
    logToTelegram(errorMsg);
  }
});

function watchMint(wallet) {
  const ws = new WebSocket(`wss://rpc.helius.xyz/?api-key=${HELIUS_KEY}`);
  activeWatchers.set(wallet, ws);

  const timeout = setTimeout(() => {
    const timeoutMsg = `⌛ [Кук-3] Mint не обнаружен в течение 20 ч.\n🕳 Отслеживание ${wallet} завершено.`;
    bot.sendMessage(PRIVATE_CHAT_ID, timeoutMsg, { parse_mode: 'HTML' });
    logToFile(timeoutMsg);
    logToTelegram(timeoutMsg);
    ws.close();
    activeWatchers.delete(wallet);
  }, 20 * 60 * 60 * 1000);

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      const ping = `📡 [Кук-3] Ping для ${wallet}`;
      console.log(ping);
      logToFile(ping);
    }
  }, 180000);

  ws.on('open', () => {
    const openMsg = `✅ [Кук-3] Начато слежение за ${wallet}`;
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
      const found = logs.find((log) =>
        log.includes('InitializeMint') || log.includes('InitializeMint2')
      );
      if (!found) return;

      const mintAddress = mentions?.[0] || 'неизвестен';
      seenSignatures.add(sig);

      clearTimeout(timeout);
      clearInterval(pingInterval);

      const mintMsg = `✅ [Кук-3] Произведён mint токена!\n🧾 Контракт: <code>${mintAddress}</code>`;
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
    const closeMsg = `❌ [Кук-3] WebSocket закрыт для ${wallet}`;
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
