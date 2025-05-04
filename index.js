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

    const notifyMsg = `⚠️ [${label}] Обнаружен перевод ${label === 'Кук-3' ? '68.99' : '99.99'} SOL\n💰 Адрес: <code>${wallet}</code>\n⏳ Ожидаем mint...`;
    bot.sendMessage(PRIVATE_CHAT_ID, notifyMsg, { parse_mode: 'HTML' });
    logToFile(notifyMsg);
    logToTelegram(notifyMsg);
  } catch (err) {
    const errorMsg = `🧨 Ошибка при обработке сообщения: ${err.message}`;
    logToFile(errorMsg);
    logToTelegram(errorMsg);
  }
});
