const fs = require("fs");
const { google } = require("googleapis");

function loadGoogleCredentials() {
    // 1. GOOGLE_CREDENTIALS env var (base64-encoded JSON — for Dokploy / containers)
    //    Generate with: base64 -w0 vilna-bot-*.json
    const credsB64 = process.env.GOOGLE_CREDENTIALS;
    if (credsB64) {
        try {
            const creds = JSON.parse(Buffer.from(credsB64, "base64").toString());
            if (creds.client_email && creds.private_key) {
                console.log("🔑 Credentials: GOOGLE_CREDENTIALS env var");
                return creds;
            }
        } catch {}
    }

    // 2. Local key file (for local dev — gitignored)
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
            "Не знайдено Google credentials. Задайте GOOGLE_CREDENTIALS (base64 JSON сервісного акаунту: base64 -w0 keyfile.json) " +
            "або покладіть vilna-bot-*.json у кореневу папку"
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
