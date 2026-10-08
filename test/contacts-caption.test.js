const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('contacts caption fits Telegram photo caption limit and keeps all required contacts', () => {
  const match = source.match(/const CONTACTS_CAPTION = `([\s\S]*?)`;/);
  assert.ok(match);
  const plain = match[1].replace(/<[^>]*>/g, '');
  assert.ok(plain.length <= 1024, `caption length ${plain.length}`);
  for (const needle of ['11:00 – 20:00', 'Дмитра Донцова, 4', 'https://t.me/vilna_dnipro', 'Бондаренко Христина', '@huliganka_kris',
    'Дарина Криворучко', '@DarynaVilna', 'Людмила Вознюк', '@luidmila_psi', 'Ми поруч. Ти не одна 🩵']) {
    assert.ok(plain.includes(needle), needle);
  }
});

test('contacts photo is sent in a single sendPhoto from assets/contacts.jpg', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'contacts.jpg')));
  assert.match(source, /path\.join\(__dirname, 'assets', 'contacts\.jpg'\)/);
  assert.match(source, /bot\.sendPhoto\(chatId, fs\.createReadStream\(CONTACTS_PHOTO_PATH\), \{\s*caption: contactsMessage,\s*parse_mode: 'HTML'/);
});
