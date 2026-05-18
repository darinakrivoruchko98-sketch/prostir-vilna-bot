const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');
if (!fs.existsSync(LOG_DIR)) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function safeAppend(file, line) {
    try {
        fs.appendFileSync(path.join(LOG_DIR, file), line + '\n');
    } catch (e) {
        // swallow logging errors to avoid recursive failures
        console.error('Logging write failed', e && e.message ? e.message : e);
    }
}

function info(...args) {
    const line = `[INFO] ${new Date().toISOString()} ` + args.map(String).join(' ');
    console.log(line);
    safeAppend('info.log', line);
}

function warn(...args) {
    const line = `[WARN] ${new Date().toISOString()} ` + args.map(String).join(' ');
    console.warn(line);
    safeAppend('warn.log', line);
}

function error(...args) {
    const line = `[ERROR] ${new Date().toISOString()} ` + args.map(String).join(' ');
    console.error(line);
    safeAppend('error.log', line);
}

module.exports = {
    info,
    warn,
    error
};
