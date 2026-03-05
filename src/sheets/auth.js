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

    // 5. Explicit key file path
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        try {
            const fileCreds = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
            if (fileCreds.client_email && fileCreds.private_key) {
                console.log(`🔑 Credentials: GOOGLE_APPLICATION_CREDENTIALS (${process.env.GOOGLE_APPLICATION_CREDENTIALS})`);
                return fileCreds;
            }
        } catch {}
    }

    // 6. Local key file (for local dev — gitignored)
    const files = fs.readdirSync(".").filter(f => /^vilna-bot-.*\.json$/.test(f));
    for (const f of files) {
        try {
            const data = JSON.parse(fs.readFileSync(f, "utf8"));
            if (data.type === "service_account" && data.client_email && data.private_key) {
                console.log("🔑 Credentials: key file", f);
                return data;
            }
        } catch {}
    }

    return null;
}

async function createAuthorizedSheetsClient() {
    const creds = loadGoogleCredentials();
    if (!creds) {
        throw new Error(
            "Не знайдено Google credentials. Задайте GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, GOOGLE_CREDENTIALS, " +
            "GOOGLE_CLIENT_EMAIL+GOOGLE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS або покладіть vilna-bot-*.json у кореневу папку"
        );
    }

    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: creds.client_email,
            private_key: creds.private_key
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const client = await auth.getClient();
    await client.getAccessToken();
    console.log("🔐 Google Sheets credentials валідні");

    return google.sheets({ version: "v4", auth: client });
}

module.exports = {
    loadGoogleCredentials,
    createAuthorizedSheetsClient,
};
