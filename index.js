
const dotenv = require('dotenv');
dotenv.config();

const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const HELIUS_KEY = process.env.HELIUS_API_KEY;

const PUBLIC_CHAT_ID = Number(process.env.PUBLIC_CHAT_ID);
const PRIVATE_CHAT_ID = Number(process.env.PRIVATE_CHAT_ID);
const BINANCE_CHAT_ID = Number(process.env.BINANCE_CHAT_ID);

const activeWatchers = new Map();
const seenSignatures = new Set();

// 🔁 Global ping every 2 min to prevent Render sleep
setInterval(() => console.log('📡 Global ping'), 120000);

// 🧯 Catch polling errors
bot.on('polling_error', (error) => {
  console.error('🐛 Polling Error:', error.message);
});

bot.on('message', (msg) => {
  try {
    const text = msg.text;
    const senderId = msg.chat.id;

    if (!text || senderId !== PUBLIC_CHAT_ID) return;
    console.log('📨 Incoming message:', text);

    let label = null;
    let timeoutMs = 0;
    let targetChatId = PRIVATE_CHAT_ID;

    if (/Кукоин\s*Биржа/i.test(text) && /99\.99\s*SOL/i.test(text)) {
      label = 'Кукоин 1';
      timeoutMs = 20 * 60 * 60 * 1000;
    } else if (/Кукоин\s*50/i.test(text) && /68\.99\s*SOL/i.test(text)) {
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

    if (!wallet || activeWatchers.has(wallet)) return;

    if (label !== 'Бинанс 99') {
      bot.sendMessage(PRIVATE_CHAT_ID,
        `⚠️ [${label}] Обнаружен перевод ${label === 'Кук 3' ? '68.99' : '99.99'} SOL\n` +
        `💰 Адрес: <code>${wallet}</code>\n⏳ Ожидаем mint...`, { parse_mode: 'HTML' });
    }

    watchMint(wallet, label, timeoutMs, targetChatId);

  } catch (err) {
    console.error('🧨 Error in message handler:', err.message);
  }
});

function watchMint(wallet, label, timeoutMs, targetChatId) {
  const ws = new WebSocket(`wss://rpc.helius.xyz/?api-key=${HELIUS_KEY}`);
  activeWatchers.set(wallet, ws);

  const timeout = setTimeout(() => {
    if (activeWatchers.has(wallet)) {
      bot.sendMessage(targetChatId,
        `⌛ [${label}] Mint не обнаружен в течение ${timeoutMs / 3600000} ч.\n🕳 Отслеживание ${wallet} завершено.`, { parse_mode: 'HTML' });
      ws.close();
      activeWatchers.delete(wallet);
    }
  }, timeoutMs);

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      console.log(`📡 [${label}] Sent WebSocket ping`);
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
        `🚀 [${label}] Mint обнаружен!\n🪙 Контракт токена: <code>${mintAddress}</code>`, { parse_mode: 'HTML' });

      ws.close();
      activeWatchers.delete(wallet);
    } catch (e) {
      console.error('⚠️ Ошибка обработки WebSocket-сообщения:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`❌ [${label}] WebSocket closed for ${wallet}`);
    clearInterval(pingInterval);
    activeWatchers.delete(wallet);
  });

  ws.on('error', (e) => {
    console.error(`💥 WebSocket error: ${e.message}`);
    clearInterval(pingInterval);
    activeWatchers.delete(wallet);
    ws.close();
  });
}
