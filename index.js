
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
const BINANCE_CHAT_ID = Number(process.env.BINANCE_CHAT_ID);

function logToTelegram(message) {
  bot.sendMessage(PRIVATE_CHAT_ID, `🪵 Лог:\n<code>${message}</code>`, { parse_mode: 'HTML' });
}

const activeWatchers = new Map();
const seenSignatures = new Set();

setInterval(() => {
  const pingMsg = '📡 Global ping';
  console.log(pingMsg);
  logToFile(pingMsg);
  logToTelegram(pingMsg);
}, 120000);

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
    let timeoutMs = 0;
    let targetChatId = PRIVATE_CHAT_ID;

    if (/Кукоин\s*Биржа/i.test(text) && /99\.99\s*SOL/i.test(text)) {
      label = 'Кукоин 1';
      timeoutMs = 20 * 60 * 60 * 1000;
    } else if (/Кукоин/i.test(text) && /68\.99\s*SOL/i.test(text)) {
      label = 'Кук 3';
      timeoutMs = 20 * 60 * 60 * 1000;
    } else if (/Бинанс\s*99/i.test(text) && /99\.99{1,2}/.test(text)) {
      label = 'Бинанс 99';
      timeoutMs = 6 * 60 * 60 * 1000;
      targetChatId = BINANCE_CHAT_ID;
    }

    if (!label) return;

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

    if (activeWatchers.has(wallet)) {
      logToFile(`🔁 Уже отслеживается: ${wallet}`);
      return;
    }

    if (label !== 'Бинанс 99') {
      const notifyMsg = `⚠️ [${label}] Обнаружен перевод ${label === 'Кук 3' ? '68.99' : '99.99'} SOL\n💰 Адрес: <code>${wallet}</code>\n⏳ Ожидаем mint...`;
      bot.sendMessage(PRIVATE_CHAT_ID, notifyMsg, { parse_mode: 'HTML' });
      logToFile(notifyMsg);
      logToTelegram(notifyMsg);
    }

    watchMint(wallet, label, timeoutMs, targetChatId);

  } catch (err) {
    const errorMsg = `🧨 Error in message handler: ${err.message}`;
    console.error(errorMsg);
    logToFile(errorMsg);
    logToTelegram(errorMsg);
  }
});

function watchMint(wallet, label, timeoutMs, targetChatId) {
  const ws = new WebSocket(`wss://rpc.helius.xyz/?api-key=${HELIUS_KEY}`);
  activeWatchers.set(wallet, ws);

  const timeout = setTimeout(() => {
    if (activeWatchers.has(wallet)) {
      const timeoutMsg = `⌛ [${label}] Mint не обнаружен в течение ${timeoutMs / 3600000} ч.\n🕳 Отслеживание ${wallet} завершено.`;
      bot.sendMessage(targetChatId, timeoutMsg, { parse_mode: 'HTML' });
      logToFile(timeoutMsg);
      logToTelegram(timeoutMsg);
      ws.close();
      activeWatchers.delete(wallet);
    }
  }, timeoutMs);

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      const ping = `📡 [${label}] Sent WebSocket ping`;
      console.log(ping);
      logToFile(ping);
      logToTelegram(ping);
    }
  }, 50000);

  ws.on('open', () => {
    const openMsg = `✅ [${label}] Listening for mint on ${wallet}`;
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

      const mintMsg = `🚀 [${label}] Mint обнаружен!\n🪙 Контракт токена: <code>${mintAddress}</code>`;
      bot.sendMessage(targetChatId, mintMsg, { parse_mode: 'HTML' });
      logToFile(mintMsg);
      logToTelegram(mintMsg);

      ws.close();
      activeWatchers.delete(wallet);
    } catch (e) {
      const errMsg = `⚠️ Ошибка обработки WebSocket-сообщения: ${e.message}`;
      console.error(errMsg);
      logToFile(errMsg);
      logToTelegram(errMsg);
    }
  });

  ws.on('close', () => {
    const msg = `❌ [${label}] WebSocket closed for ${wallet}`;
    console.log(msg);
    logToFile(msg);
    logToTelegram(msg);
    clearInterval(pingInterval);
    activeWatchers.delete(wallet);
  });

  ws.on('error', (e) => {
    const errMsg = `💥 WebSocket error: ${e.message}`;
    console.error(errMsg);
    logToFile(errMsg);
    logToTelegram(errMsg);
    clearInterval(pingInterval);
    activeWatchers.delete(wallet);
    ws.close();
  });
}
