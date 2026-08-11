function clearFeedbackFlowState(user) {
    if (!user || typeof user !== 'object') {
        return user;
    }

    if (user.context === 'daily-feedback-write') {
        user.context = null;
    }

    delete user.pendingFeedbackDateKey;
    return user;
}

module.exports = {
    clearFeedbackFlowState
};
