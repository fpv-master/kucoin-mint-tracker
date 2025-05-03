
const TelegramBot = require("node-telegram-bot-api");
const WebSocket = require("ws");

require("dotenv").config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const TRACKER_CONFIGS = [
  {
    name: "Кукоин 1",
    matchText: "Кукоин Биржа · SOL",
    amount: "99.99",
    timeoutHours: 20,
    notifyTransfer: true,
    chatId: process.env.KUCOIN1_CHAT_ID,
  },
  {
    name: "Бинанс 99",
    matchText: "Кукоин 50 · SOL",
    amount: "68.99",
    timeoutHours: 6,
    notifyTransfer: false,
    chatId: process.env.BINANCE99_CHAT_ID,
  },
];

const MINT_INSTRUCTION = "InitializeMint2";
const activeListeners = {};

function extractAddress(text) {
  const match = text.match(/https:\/\/solscan\.io\/account\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

bot.on("message", async (msg) => {
  const text = msg.text || "";
  for (const config of TRACKER_CONFIGS) {
    if (text.includes(config.matchText) && text.includes(config.amount)) {
      const address = extractAddress(text);
      if (!address || activeListeners[address]) return;

      activeListeners[address] = true;

      if (config.notifyTransfer) {
        bot.sendMessage(config.chatId, `⚠️ [${config.name}] Обнаружен перевод ${config.amount} SOL
💰 Адрес:
<code>${address}</code>
⏳ Ожидаем mint...`, {
          parse_mode: "HTML",
        });
      }

      listenForMint(address, config);
    }
  }
});

function listenForMint(address, config) {
  const ws = new WebSocket("wss://rpc.helius.xyz");

  const pingInterval = setInterval(() => {
    ws.readyState === WebSocket.OPEN && ws.ping();
  }, 50000);

  ws.on("open", () => {
    console.log(`✅ [${config.name}] Listening for mint on ${address}`);
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          {
            mentions: [address],
          },
          {
            commitment: "confirmed",
          },
        ],
      })
    );
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    const logs = msg?.params?.result?.value?.logs || [];

    if (logs.some((log) => log.includes(MINT_INSTRUCTION))) {
      const signature = msg.params.result.value.signature;
      const solscan = `https://solscan.io/tx/${signature}`;
      bot.sendMessage(config.chatId, `⚡️ [${config.name}] Mint обнаружен!
🔗 <a href="${solscan}">Открыть в Solscan</a>`, {
        parse_mode: "HTML",
      });

      clearInterval(pingInterval);
      ws.close();
      delete activeListeners[address];
    }
  });

  ws.on("close", () => {
    console.log(`❌ [${config.name}] WebSocket closed for ${address}`);
    clearInterval(pingInterval);
    delete activeListeners[address];
  });

  setTimeout(() => {
    console.log(`⏱ [${config.name}] Таймер истёк, закрываем слежку за ${address}`);
    ws.close();
    clearInterval(pingInterval);
    delete activeListeners[address];
  }, config.timeoutHours * 60 * 60 * 1000);
}
