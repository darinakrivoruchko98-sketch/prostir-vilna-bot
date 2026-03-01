# Prostir Vilna Bot

Telegram бот для реєстрації на заходи в Простір Вільна.

## Налаштування на Railway

### 1. Змінні середовища (Environment Variables)

В Railway Dashboard додайте наступні змінні:

```
TOKEN=your_telegram_bot_token
GROUP_ID=-1003282996506
CHAT_ID=-1003282996506
SPREADSHEET_ID=1jTTWx_74ua3iMK1nGih7trPeNVQnO59Kp4HQ5TPQgQ8
PERSONAL_DATA_SPREADSHEET_ID=1hbpFgrCAECIYSLkgYzXUe2OgV_3FxI3NWvEwUxyizQE
PERSONAL_DATA_SHEET_NAME=Березень
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
```

Бот читає реєстрації з аркуша `Реєстрація` (або fallback `Реєстрації`) у таблиці `SPREADSHEET_ID`,
а персональні дані записує в аркуш `Березень` (або значення `PERSONAL_DATA_SHEET_NAME`) у таблиці `PERSONAL_DATA_SPREADSHEET_ID`.

### 2. Google Service Account JSON

Для `GOOGLE_SERVICE_ACCOUNT_JSON` скопіюйте весь вміст файлу `vilna-bot-8e7e5cb23ce2.json` в одну лінію (як JSON string).


Альтернативи:
- `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (base64 від JSON service account)
- `GOOGLE_APPLICATION_CREDENTIALS=/app/credentials.json`

### 3. Деплой

Railway автоматично задеплоїть бот після пушу в `main` гілку.

## Локальна розробка

1. Створіть `.env` файл (можна взяти за основу `.env.example`):
```
TOKEN=your_token
GROUP_ID=-1003282996506
CHAT_ID=-1003282996506
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}
```

2. Якщо не хочете зберігати JSON у `.env`, покладіть локальний файл `vilna-bot-*.json` у корінь проєкту.

3. Запустіть:
```bash
npm install
npm start
```
