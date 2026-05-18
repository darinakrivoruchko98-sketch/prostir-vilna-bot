const fs = require("fs");
const { google } = require("googleapis");

function parseJsonOrBase64ServiceAccount(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') return null;
    const candidate = rawValue.trim();
    if (!candidate) return null;

    try {
        const parsed = JSON.parse(candidate);
        if (parsed.client_email && parsed.private_key) {
            return parsed;
        }
    } catch (e) {
        // ignore
    }

    try {
        const compact = candidate.replace(/\s+/g, '');
        const decoded = Buffer.from(compact, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (parsed.client_email && parsed.private_key) {
            return parsed;
        }
    } catch (e) {
        // ignore
    }

    return null;
}

function loadGoogleCredentials() {
    const candidates = [
        {
            env: 'GOOGLE_SERVICE_ACCOUNT_JSON',
            parser: (value) => parseJsonOrBase64ServiceAccount(value)
        },
        {
            env: 'GOOGLE_SERVICE_ACCOUNT_JSON_BASE64',
            parser: (value) => parseJsonOrBase64ServiceAccount(value)
        },
        {
            env: 'GOOGLE_CREDENTIALS',
            parser: (value) => parseJsonOrBase64ServiceAccount(value)
        },
        {
            env: 'GOOGLE_CREDENTIALS_JSON',
            parser: (value) => parseJsonOrBase64ServiceAccount(value)
        },
        {
            env: 'GOOGLE_APPLICATION_CREDENTIALS_JSON',
            parser: (value) => parseJsonOrBase64ServiceAccount(value)
        },
        {
            env: 'GCP_SERVICE_ACCOUNT_JSON',
            parser: (value) => parseJsonOrBase64ServiceAccount(value)
        }
    ];

    for (const candidate of candidates) {
        const raw = process.env[candidate.env];
        if (!raw) continue;
        const creds = candidate.parser(raw);
        if (creds && creds.client_email && creds.private_key) {
            console.log(`🔑 Credentials: ${candidate.env}`);
            return creds;
        }
    }

    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        console.log("🔑 Credentials: GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY env vars");
        return {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY,
        };
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS.trim();
        try {
            if (gac.startsWith("{")) {
                const inlineCreds = JSON.parse(gac);
                if (inlineCreds.client_email && inlineCreds.private_key) {
                    console.log("🔑 Credentials: GOOGLE_APPLICATION_CREDENTIALS (inline JSON)");
                    return inlineCreds;
                }
            } else {
                const fileCreds = JSON.parse(fs.readFileSync(gac, "utf8"));
                if (fileCreds.client_email && fileCreds.private_key) {
                    console.log(`🔑 Credentials: GOOGLE_APPLICATION_CREDENTIALS (${gac})`);
                    return fileCreds;
                }
            }
        } catch (e) {
            console.log(`⚠️ GOOGLE_APPLICATION_CREDENTIALS не вдалося прочитати: ${e.message}`);
        }
    }

    // 6. Local key file (for local dev — gitignored)
    try {
        const files = fs.readdirSync(".").filter(f => /^vilna-bot-.*\.json$/.test(f));
        for (const f of files) {
            try {
                const data = JSON.parse(fs.readFileSync(f, "utf8"));
                if (data.type === "service_account" && data.client_email && data.private_key) {
                    console.log("🔑 Credentials: key file", f);
                    return data;
                }
            } catch (e) {
                console.log(`⚠️ Помилка читання файлу ${f}:`, e.message);
            }
        }
    } catch (e) {
        console.log("⚠️ Помилка при пошуку локальних файлів:", e.message);
    }

    return null;
}

async function createAuthorizedSheetsClient() {
    const creds = loadGoogleCredentials();
    if (!creds) {
        console.error("❌ Google credentials не знайдено!");
        throw new Error(
            "Не знайдено Google credentials. Задайте GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, GOOGLE_CREDENTIALS, " +
            "GOOGLE_CLIENT_EMAIL+GOOGLE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS або покладіть vilna-bot-*.json у кореневу папку"
        );
    }

    console.log(`✅ Credentials завантажені від ${creds.client_email}`);

    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: creds.client_email,
            private_key: creds.private_key
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    try {
        const client = await auth.getClient();
        const token = await client.getAccessToken();
        console.log(`🔐 Google Sheets credentials валідні`);
        console.log(`   Service account: ${creds.client_email}`);
        return google.sheets({ version: "v4", auth: client });
    } catch (error) {
        console.error(`\n❌ === ПОМИЛКА АВТОРИЗАЦІЇ GOOGLE SHEETS ===`);
        console.error(`Помилка: ${error && error.message ? error.message : error}`);
        console.error(`Email service account: ${creds.client_email}`);
        console.error(`\n💡 Перевірте:`);
        console.error(`   1. Чи додано ${creds.client_email} як редактор до обох Google Sheets`);
        console.error(`   2. Чи правильно скопійовані дані credentials у .env`);
        console.error(`   3. Чи активовано Google Sheets API у Google Cloud Console`);
        console.error(`=====================================\n`);
        throw error;
    }
}

module.exports = {
    loadGoogleCredentials,
    createAuthorizedSheetsClient,
};
