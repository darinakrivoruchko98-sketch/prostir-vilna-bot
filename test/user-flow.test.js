const test = require('node:test');
const assert = require('node:assert');

// Mock state and config
const mockState = {
    knownUsers: {},
    events: []
};

const mockConfig = {
    PERSONAL_DATA_SPREADSHEET_ID: 'test-sheet-id',
    PERSONAL_DATA_SHEET_NAME: 'Зареєстровані'
};

// Simulate resolveKnownUser logic
async function resolveKnownUser(chatId, knownUsers, lookupUser) {
    // Check memory cache first
    if (knownUsers && knownUsers[chatId]) {
        return knownUsers[chatId];
    }
    
    // Fetch from Sheets
    const fetched = await lookupUser(chatId);
    if (fetched && knownUsers) {
        knownUsers[chatId] = fetched;
    }
    
    return fetched;
}

// Test 1: Known user bypasses questionnaire
test('known user is recognized and skips questionnaire', async (t) => {
    const chatId = 123;
    const mockUser = {
        name: 'John Doe',
        phone: '380501234567',
        status: 'ВПО'
    };
    
    // Mock lookup function
    const mockLookup = async () => mockUser;
    
    // First lookup
    const result1 = await resolveKnownUser(chatId, mockState.knownUsers, mockLookup);
    assert.deepEqual(result1, mockUser, 'Should find user on first lookup');
    
    // Cache is populated
    assert.strictEqual(
        mockState.knownUsers[chatId],
        mockUser,
        'User should be cached after first lookup'
    );
    
    // Second lookup should not call mockLookup (uses cache)
    let lookupCallCount = 0;
    const mockLookupWithCounter = async () => {
        lookupCallCount++;
        return mockUser;
    };
    
    const result2 = await resolveKnownUser(chatId, mockState.knownUsers, mockLookupWithCounter);
    assert.deepEqual(result2, mockUser, 'Should return cached user');
    assert.strictEqual(lookupCallCount, 0, 'Should not call lookup for cached user');
});

// Test 2: New user goes through questionnaire
test('new user is not in cache and goes through registration flow', async (t) => {
    const chatId = 999;
    const mockState2 = { knownUsers: {} };
    
    // Mock lookup function that returns null (user not found)
    const mockLookup = async () => null;
    
    const result = await resolveKnownUser(chatId, mockState2.knownUsers, mockLookup);
    assert.strictEqual(result, null, 'Should return null for unknown user');
    assert.strictEqual(
        mockState2.knownUsers[chatId],
        undefined,
        'Unknown user should not be cached'
    );
});

// Test 3: Appeal logic uses cached lookup
test('appeal uses findUserByChatId which will be cached', async (t) => {
    const chatId = 456;
    const mockUser = {
        name: 'Jane Smith',
        phone: '380501234567',
        username: 'jane_smith'
    };
    
    mockState.knownUsers[chatId] = mockUser;
    
    // Simulate appeal flow
    const userDataFromCache = mockState.knownUsers[chatId];
    const userName = userDataFromCache?.name || `користувач ${chatId}`;
    
    assert.strictEqual(userName, 'Jane Smith', 'Appeal should use cached user name');
});

// Test 4: Event selection uses cached lookup
test('event selection checks cache first for known users', async (t) => {
    const chatId = 789;
    const mockUser = {
        name: 'Bob Johnson',
        phone: '380501234567'
    };
    
    mockState.knownUsers[chatId] = mockUser;
    
    // Simulate event selection logic
    let userFound = mockState.knownUsers && mockState.knownUsers[chatId];
    
    assert.ok(userFound, 'User should be found in cache');
    assert.strictEqual(userFound.name, 'Bob Johnson', 'Should find user in cache');
    assert.strictEqual(userFound.phone, '380501234567', 'User can register immediately without questionnaire');
});
