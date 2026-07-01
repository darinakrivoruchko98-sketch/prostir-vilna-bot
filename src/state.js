module.exports = {
    users: {},
    knownUsers: {},  // cache: chatId -> { name, phone, ... } — persisted in Google Sheet
    events: [],
    sheetsClient: null,
    bot: null,
    pollingStarted: false,
    sheetsRefreshInterval: null,
};
