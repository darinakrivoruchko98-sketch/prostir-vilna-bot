function hasCompleteRegistrationProfile(profile) {
    if (!profile) return false;

    return Boolean(
        profile.name &&
        profile.phone &&
        profile.birth &&
        profile.status &&
        profile.childrenCount &&
        profile.health &&
        profile.evacuationStatus &&
        profile.shellingImpact &&
        profile.employment &&
        profile.beneficiaryCategory &&
        profile.gzn
    );
}

function hasLikelyRegistrantNameShape(value) {
    const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
    return tokens.length >= 2 && tokens.every((token) => /^\p{L}+(?:['’ʼ-]\p{L}+)*$/u.test(token));
}

module.exports = {
    hasCompleteRegistrationProfile,
    hasLikelyRegistrantNameShape
};
