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
PERSONAL_DATA_SHEET_NAME=Зареєстровані
SOCIAL_CONSULTATIONS_SHEET_NAME=Соц
PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME=Псих
SOCIAL_SPECIALIST_CHAT_ID=-100xxxxxxxxxx
PSYCHOLOGIST_CHAT_ID=-100xxxxxxxxxx
BOT_USERNAME=your_bot_username_without_@
BOT_DISPLAY_NAME=Бот простору Вільна
BOT_DESCRIPTION=🌿 Простір Вільна — місце підтримки, творчості та відновлення у м. Дніпро...
BOT_SHORT_DESCRIPTION=Чат-бот Простору Вільна: анонси, реєстрація та підтримка
AI_API_KEY=sk-...
AI_MODEL=gpt-4o-mini
AI_API_URL=https://api.openai.com/v1/chat/completions
GOOGLE_CLIENT_EMAIL=your-service-account@project-id.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"
```

**ВАЖЛИВО:** 
- Railway автоматично встановлює `RAILWAY_URL` - не треба додавати вручну
- `PORT` - Railway автоматично встановлює порт

Розклад читається з аркуша `Розклад` (або значення `SCHEDULE_SHEET_NAME`) у таблиці `SPREADSHEET_ID`,
а персональні дані записуються в аркуш `Зареєстровані` (або значення `PERSONAL_DATA_SHEET_NAME`) у таблиці `PERSONAL_DATA_SPREADSHEET_ID`.

Для індивідуальних консультацій бот пише записи в аркуші `Соц` та `Псих` (або значення `SOCIAL_CONSULTATIONS_SHEET_NAME` і `PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME`) у таблиці `PERSONAL_DATA_SPREADSHEET_ID`.
Сповіщення для фахівчинь надсилаються в чати, вказані в `SOCIAL_SPECIALIST_CHAT_ID` та `PSYCHOLOGIST_CHAT_ID`.

ШІ-режим працює, якщо задано `AI_API_KEY`. Якщо ключа немає, бот покаже стандартні кнопки меню без відповіді ШІ.

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
SOCIAL_CONSULTATIONS_SHEET_NAME=Соц
PSYCHOLOGICAL_CONSULTATIONS_SHEET_NAME=Псих
SOCIAL_SPECIALIST_CHAT_ID=-100xxxxxxxxxx
PSYCHOLOGIST_CHAT_ID=-100xxxxxxxxxx
BOT_USERNAME=your_bot_username_without_@
BOT_DISPLAY_NAME=Бот простору Вільна
BOT_DESCRIPTION=🌿 Простір Вільна — місце підтримки, творчості та відновлення у м. Дніпро...
BOT_SHORT_DESCRIPTION=Чат-бот Простору Вільна: анонси, реєстрація та підтримка
AI_API_KEY=sk-...
AI_MODEL=gpt-4o-mini
AI_API_URL=https://api.openai.com/v1/chat/completions
GOOGLE_CLIENT_EMAIL=your-service-account@project-id.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"
```

2. Запустіть:
```bash
npm install
npm start
```
