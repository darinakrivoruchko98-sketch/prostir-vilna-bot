const express = require("express");
const bodyParser = require("body-parser");
const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.TOKEN;

if (!TOKEN) {
    console.error("TOKEN не установлен");
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    bot.sendMessage(
        chatId,
        "🤍 Вітаємо у боті Простору «Вільна»!\nНатисніть меню → Реєстрація"
    );

    bot.sendMessage(chatId, "Меню:", {
        reply_markup: {
            keyboard: [[{ text: "Реєстрація" }]],
            resize_keyboard: true
        }
    });
});

const app = express();
app.use(bodyParser.json());

app.listen(3000, () => {
    console.log("Server running");
});
