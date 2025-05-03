import dotenv from 'dotenv';
dotenv.config();

import TelegramBot from 'node-telegram-bot-api';
import WebSocket from 'ws';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const activeWatchers = new Map();
const seenSignatures = new Set();

bot.on('message', (msg) => {
  const text = msg.text;
  if (!text) return;

  // 🧠 Проверяем текст и сумму
  let label = null;
  if (text.includes('Кукоин Биржа') && text.includes('99.99 SOL')) {
    label = 'Кукоин 1';
  } else if (text.includes('Кукоин 50') && text.includes('68.99 SOL')) {
    label = 'Кук 3';
  }

  if (!label) return;

  // 🔗 Ищем адрес в ссылке на solscan
  const linkMatch = text.match(/solscan\.io\/account\/(\w{32,44})/);
  const wallet = linkMatch?.[1];
  if (!wallet) return;

  if (activeWatchers.has(wallet)) return;

  bot.sendMessage(CHAT_ID, `🧭 Внимание, ${label} готовит монету\n💰 Адрес: <code>${wallet}</code>`, { parse_mode: 'HTML' });
  watchMint(wallet, label);
});

function watchMint(wallet, label) {
  const ws = new WebSocket(`wss://rpc.helius.xyz/?api-key=${HELIUS_KEY}`);
  activeWatchers.set(wallet, ws);

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
      if (!sig || seenSignatures.has(sig)) return;

      const found = logs.find((log) =>
        log.includes('InitializeMint') || log.includes('InitializeMint2')
      );
      if (!found) return;

      seenSignatures.add(sig);
      bot.sendMessage(CHAT_ID, `⚡️ ${label}: Mint обнаружен\n🔗 https://solscan.io/tx/${sig}`, { parse_mode: 'HTML' });
      ws.close();
      activeWatchers.delete(wallet);
    } catch {}
  });

  ws.on('close', () => {
    console.log(`❌ [${label}] WebSocket closed for ${wallet}`);
    activeWatchers.delete(wallet);
  });

  ws.on('error', (e) => console.log(`💥 WebSocket error: ${e.message}`));
}
