process.env.TZ = process.env.TZ || 'Europe/Kyiv';
require('dotenv').config();

const bootstrapAppealsGroupId = Number(process.env.APPEALS_GROUP_ID || '-1003802751255');
globalThis.APPEALS_GROUP_ID = bootstrapAppealsGroupId;

console.log(`[BOOT] Starting via bootstrap.js`);
console.log(`[BOOT] APPEALS_GROUP_ID=${bootstrapAppealsGroupId}`);

require('./server');
