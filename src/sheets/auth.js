const fs = require("fs");
const { google } = require("googleapis");

function loadGoogleCredentials() {
    // 1. GOOGLE_CREDENTIALS env var (base64-encoded JSON — for Dokploy / containers)
    //    Generate with: base64 -w0 vilna-bot-*.json
    const credsB64 = process.env.GOOGLE_CREDENTIALS;
    if (credsB64) {
        try {
            let creds = null;
            try {
                creds = JSON.parse(credsB64);
            } catch {
                creds = JSON.parse(Buffer.from(credsB64, "base64").toString());
            }
            if (creds.client_email && creds.private_key) {
                console.log("🔑 Credentials: GOOGLE_CREDENTIALS env var");
                return creds;
            }
        } catch {}
    }

    // 2. GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON string)
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        try {
            const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
            if (creds.client_email && creds.private_key) {
                console.log("🔑 Credentials: GOOGLE_SERVICE_ACCOUNT_JSON env var");
                return creds;
            }
        } catch {}
    }

    // 3. GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 (base64-encoded JSON)
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
        try {
            const creds = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, "base64").toString());
            if (creds.client_email && creds.private_key) {
                console.log("🔑 Credentials: GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 env var");
                return creds;
            }
        } catch {}
    }

    // 4. Split env fields (common on Railway)
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        console.log("🔑 Credentials: GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY env vars");
        return {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY,
        };
    }

    // 5. GOOGLE_APPLICATION_CREDENTIALS can be either:
    //    - a file path (classic behavior)
    //    - a raw JSON string (common misconfiguration on Railway)
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
        const allFiles = fs.readdirSync(".");
        console.log("📁 Файли в поточній папці:", allFiles.filter(f => f.endsWith('.json')));
        
        const files = allFiles.filter(f => /^vilna-bot-.*\.json$/.test(f));
        console.log("🔍 Знайдено файлів credentials з регулярним виразом:", files);
        
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
