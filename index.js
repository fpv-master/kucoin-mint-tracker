
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

const PUBLIC_CHAT_ID = process.env.PUBLIC_CHAT_ID;
const PRIVATE_CHAT_ID = process.env.PRIVATE_CHAT_ID;
const WATCH_TIMEOUT_MS = 20 * 60 * 60 * 1000; // 20 часов
const KUCOIN_1_AMOUNT = 99.99;
const KUCOIN_3_AMOUNT = 68.99;

const watchedAddresses = new Map();

function parseAddressFromText(text) {
  const regex = /https:\/\/solscan\.io\/account\/([a-zA-Z0-9]+)/;
  const match = text.match(regex);
  return match ? match[1] : null;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (String(chatId) !== PUBLIC_CHAT_ID) return;
  if (!msg.text) return;

  const address = parseAddressFromText(msg.text);
  if (!address) return;

  let devLabel = null;
  if (msg.text.includes('Кукоин Биржа') && msg.text.includes(KUCOIN_1_AMOUNT.toString())) {
    devLabel = 'Кукоин 1';
  } else if (msg.text.includes('Кукоин 50') && msg.text.includes(KUCOIN_3_AMOUNT.toString())) {
    devLabel = 'Кук 3';
  }

  if (!devLabel || watchedAddresses.has(address)) return;

  watchedAddresses.set(address, true);
  const notice = `⚠️ [${devLabel}] Обнаружен перевод ${devLabel === 'Кук 3' ? KUCOIN_3_AMOUNT : KUCOIN_1_AMOUNT} SOL\n💰 Адрес:\n\`${address}\`\n⏳ Ожидаем mint...`;
  await bot.sendMessage(PRIVATE_CHAT_ID, notice, { parse_mode: 'Markdown' });
  console.log(`✅ [${devLabel}] Listening for mint on ${address}`);

  const ws = new WebSocket('wss://mainnet.helius-rpc.com/');

  ws.on('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [address] },
        { commitment: 'confirmed' }
      ]
    }));

    // Пинг каждые 50 секунд
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        console.log('📡 Sent ping');
      }
    }, 50 * 1000);

    // Завершить слежку через 20 часов
    setTimeout(() => {
      ws.close();
      clearInterval(pingInterval);
      watchedAddresses.delete(address);
      console.log(`❌ Timeout reached, unsubscribed from ${address}`);
    }, WATCH_TIMEOUT_MS);
  });

  ws.on('message', async (data) => {
    try {
      const parsed = JSON.parse(data);
      const logs = parsed.params?.result?.value?.logs || [];
      const found = logs.find((line) => line.includes('InitializeMint2'));
      if (found) {
        const sig = parsed.params?.result?.value?.signature;
        const url = `https://solscan.io/tx/${sig}`;
        const text = `⚡️ New Token Created!\n🔗 [Open TX](${url})\n💰 Минт с адреса: \`${address}\``;
        await bot.sendMessage(PRIVATE_CHAT_ID, text, { parse_mode: 'Markdown' });
        console.log(`✅ Mint found! ${sig}`);
        ws.close();
        watchedAddresses.delete(address);
      }
    } catch (e) {
      console.warn('Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    console.log(`❌ WebSocket closed for ${address}`);
  });

  ws.on('error', (err) => {
    console.error(`💥 WebSocket error for ${address}:`, err.message);
  });
});
