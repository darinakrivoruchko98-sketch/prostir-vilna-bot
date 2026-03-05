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
SCHEDULE_SHEET_NAME=Розклад
PERSONAL_DATA_SPREADSHEET_ID=1hbpFgrCAECIYSLkgYzXUe2OgV_3FxI3NWvEwUxyizQE
PERSONAL_DATA_SHEET_NAME=Березень
GOOGLE_CLIENT_EMAIL=your-service-account@project-id.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"
```

**ВАЖЛИВО:** 
- Railway автоматично встановлює `RAILWAY_URL` - не треба додавати вручну
- `PORT` - Railway автоматично встановлює порт

Розклад читається з аркуша `Розклад` (або значення `SCHEDULE_SHEET_NAME`) у таблиці `SPREADSHEET_ID`,
а персональні дані записуються в аркуш `Березень` (або значення `PERSONAL_DATA_SHEET_NAME`) у таблиці `PERSONAL_DATA_SPREADSHEET_ID`.

### 2. Google Service Account (тільки через env)

Бот не читає локальні `*.json` ключі і не використовує `GOOGLE_APPLICATION_CREDENTIALS`.

Використовуйте лише:
- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY` (з `\\n` у значенні)

### 3. Деплой на Railway

1. Підключіть GitHub репозиторій до Railway
2. Railway автоматично задеплоїть бот після пушу в `main` гілку
3. Після першого деплою:
   - Перейдіть **Settings** → **Networking**
   - Натисніть **Generate Domain**
   - Railway автоматично встановить змінну `RAILWAY_URL`

### 4. Перевірка

Після деплою перевірте, що все працює:
- Відкрийте `https://your-app-name.up.railway.app/health` - має показати статус
- Перевірте логи на Railway - має бути повідомлення "✅ Webhook встановлено успішно"
- Напишіть боту в Telegram - має відповісти

## Локальна розробка

1. Створіть `.env` файл (можна взяти за основу `.env.example`):
```
TOKEN=your_token
GROUP_ID=-1003282996506
CHAT_ID=-1003282996506
SPREADSHEET_ID=your_spreadsheet_id
GOOGLE_CLIENT_EMAIL=your-service-account@project-id.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"
```

2. Запустіть:
```bash
npm install
npm start
```
