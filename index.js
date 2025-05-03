const dotenv = require('dotenv');
dotenv.config();

const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const HELIUS_KEY = process.env.HELIUS_API_KEY;

const PUBLIC_CHAT_ID = process.env.PUBLIC_CHAT_ID;
const PRIVATE_CHAT_ID = process.env.PRIVATE_CHAT_ID;
const BINANCE_CHAT_ID = process.env.BINANCE_CHAT_ID;

const activeWatchers = new Map();
const seenSignatures = new Set();

bot.on('message', (msg) => {
  const text = msg.text;
  const senderId = msg.chat.id;
  if (!text || senderId !== Number(PUBLIC_CHAT_ID)) return;

  let label = null;
  let timeoutMs = 0;
  let targetChatId = PRIVATE_CHAT_ID;

  if (text.includes('Кукоин Биржа') && text.includes('99.99 SOL')) {
    label = 'Кукоин 1';
    timeoutMs = 20 * 60 * 60 * 1000;
  } else if (text.includes('Кукоин 50') && text.includes('68.99 SOL')) {
    label = 'Кук 3';
    timeoutMs = 20 * 60 * 60 * 1000;
  } else if (text.includes('Бинанс 99') && text.includes('99.99')) {
    label = 'Бинанс 99';
    timeoutMs = 6 * 60 * 60 * 1000;
    targetChatId = BINANCE_CHAT_ID;
  }

  if (!label) return;

  const linkMatch = text.match(/solscan\.io\/account\/(\w{32,44})/);
  const wallet = linkMatch?.[1];
  if (!wallet || activeWatchers.has(wallet)) return;

  if (label !== 'Бинанс 99') {
    bot.sendMessage(PRIVATE_CHAT_ID,
      `⚠️ [${label}] Обнаружен перевод ${label === 'Кук 3' ? '68.99' : '99.99'} SOL\n` +
      `💰 Адрес: <code>${wallet}</code>\n` +
      `⏳ Ожидаем mint...`, { parse_mode: 'HTML' });
  }

  watchMint(wallet, label, timeoutMs, targetChatId);
});

function watchMint(wallet, label, timeoutMs, targetChatId) {
  const ws = new WebSocket(`wss://rpc.helius.xyz/?api-key=${HELIUS_KEY}`);
  activeWatchers.set(wallet, ws);

  const timeout = setTimeout(() => {
    if (activeWatchers.has(wallet)) {
      bot.sendMessage(targetChatId,
        `⌛ [${label}] Mint не обнаружен в течение ${timeoutMs / 3600000} ч.\n` +
        `🕳 Отслеживание ${wallet} завершено.`, { parse_mode: 'HTML' });
      ws.close();
      activeWatchers.delete(wallet);
    }
  }, timeoutMs);

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log('📡 Sent ping');
    }
  }, 50000);

  ws.on('open', () => {
    console.log(`✅ [${label}] Listening for mint on ${wallet}`);
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

      bot.sendMessage(targetChatId,
        `🚀 [${label}] Mint обнаружен!\n` +
        `🪙 Контракт токена: <code>${mintAddress}</code>`, { parse_mode: 'HTML' });

      ws.close();
      activeWatchers.delete(wallet);
    } catch (e) {
      console.log('⚠️ Ошибка обработки сообщения:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`❌ [${label}] WebSocket closed for ${wallet}`);
    clearInterval(pingInterval);
    activeWatchers.delete(wallet);
  });

  ws.on('error', (e) => console.log(`💥 WebSocket error: ${e.message}`));
}