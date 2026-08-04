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

module.exports = {
    hasCompleteRegistrationProfile
};
