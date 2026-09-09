async function cancelAfishaRegistrationButton({
    chatId,
    user,
    registrations,
    unregisterFromEvent,
    unregisterFromReserve,
    sendMessage,
    getAfishaInstantRegistrationKeyboard
}) {
    const lastEventId = user && user.lastAfishaRegisteredEventId;

    if (!lastEventId) {
        await sendMessage(chatId, 'Немає активної реєстрації для скасування.', {
            reply_markup: {
                keyboard: getAfishaInstantRegistrationKeyboard(),
                resize_keyboard: true
            }
        });
        return { handled: true, status: 'no-active-registration' };
    }

    let result = await unregisterFromEvent(chatId, lastEventId);
    if (!result || result.status !== 'ok') {
        result = await unregisterFromReserve(chatId, lastEventId);
    }

    if (result && result.status === 'ok') {
        const details = result.mode === 'reserve'
            ? 'Запис у резерв скасовано.'
            : 'Місце звільнено для інших учасників.';
        await sendMessage(chatId,
            `✅ <b>Реєстрацію скасовано.</b>\n\n📌 ${result.eventName}\n\n${details}`, {
                parse_mode: 'HTML',
                reply_markup: {
                    keyboard: getAfishaInstantRegistrationKeyboard(),
                    resize_keyboard: true
                }
            });
        delete user.lastAfishaRegisteredEventId;
        delete user.lastAfishaRegisteredEventName;
        return { handled: true, status: 'ok' };
    }

    await sendMessage(chatId, '❌ Не вдалося скасувати реєстрацію. Спробуйте ще раз.', {
        reply_markup: {
            keyboard: getAfishaInstantRegistrationKeyboard(),
            resize_keyboard: true
        }
    });
    return { handled: true, status: 'failed' };
}

function isRegistrationCancelText(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return false;

    return [
        '❌ Скасувати реєстрацію',
        '❌ Відмінити реєстрацію',
        '❌ Відмінити',
        '❌ Скасувати'
    ].includes(normalized);
}

module.exports = {
    cancelAfishaRegistrationButton,
    isRegistrationCancelText
};
