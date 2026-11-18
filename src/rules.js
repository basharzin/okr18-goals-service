// ---------------------------------------------------------------
// Goals business rules (G1 to G8 in the design doc).
// Pure functions: no database, no network, no clock of their own.
// Everything they need is passed in, so each rule can be tested alone.
// ---------------------------------------------------------------

const STATUS = Object.freeze({
    DRAFT: 'Draft',
    ACTIVE: 'Active',
    AT_RISK: 'AtRisk',
    ACHIEVED: 'Achieved',
    ABANDONED: 'Abandoned'
});

// G3: at most this many Active or At Risk goals per user per year
const MAX_ACTIVE_GOALS = 5;

// G6: a goal is "on track" while it is at most this many points behind schedule
const HEALTH_TOLERANCE = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

// A rule that fails returns { ok: false, status, code, message };
// a rule that passes returns { ok: true }.
const pass = () => ({ ok: true });
const fail = (status, code, message) => ({ ok: false, status, code, message });

function isActiveLike(status) {
    return status === STATUS.ACTIVE || status === STATUS.AT_RISK;
}

// G1: the moves a USER may ask for. Active <-> AtRisk is only done by the
// daily health scan, so a user can never ask for "AtRisk".
const USER_MOVES = Object.freeze({
    [STATUS.DRAFT]: [STATUS.ACTIVE],
    [STATUS.ACTIVE]: [STATUS.ACHIEVED, STATUS.ABANDONED],
    [STATUS.AT_RISK]: [STATUS.ACHIEVED, STATUS.ABANDONED],
    [STATUS.ABANDONED]: [STATUS.ACTIVE],            // reopen (G5)
    [STATUS.ACHIEVED]: []                            // final
});

/**
 * Checks one requested state change against G1 to G5.
 * @param goal        the stored goal
 * @param to          the status the user asked for
 * @param facts       what other services told us:
 *                    { keyResultCount, progress, activeGoalsThisYear, reason, now }
 */
function checkTransition(goal, to, facts) {
    const allowed = USER_MOVES[goal.status] || [];
    if (!allowed.includes(to)) {
        return fail(409, 'INVALID_TRANSITION', `A ${goal.status} goal cannot move to ${to}.`);
    }

    if (to === STATUS.ACTIVE) {
        // G5: reopening an abandoned goal: once, and only in the goal's own year
        if (goal.status === STATUS.ABANDONED) {
            if (goal.reopened) {
                return fail(409, 'REOPEN_NOT_ALLOWED', 'This goal has already been reopened once.');
            }
            if (yearOf(facts.now) !== goal.year) {
                return fail(409, 'REOPEN_NOT_ALLOWED', 'A goal can only be reopened in its own year.');
            }
        }
        // G2: there must be something to measure
        if (!(facts.keyResultCount >= 1)) {
            return fail(409, 'NO_KEY_RESULTS', 'Add at least one key result before activating this goal.');
        }
        // G3: limit on goals in play at the same time
        if (facts.activeGoalsThisYear >= MAX_ACTIVE_GOALS) {
            return fail(409, 'GOAL_LIMIT', `You already have ${MAX_ACTIVE_GOALS} active goals for ${goal.year}.`);
        }
    }

    if (to === STATUS.ACHIEVED && !(facts.progress >= 100)) {
        // G4: progress comes from the Key Results service, never from the client
        return fail(409, 'NOT_COMPLETE', `Progress is ${Math.floor(facts.progress || 0)}%. A goal is achieved at 100%.`);
    }

    if (to === STATUS.ABANDONED) {
        // G5: a reason is required (10 to 200 characters)
        const reason = typeof facts.reason === 'string' ? facts.reason.trim() : '';
        if (reason.length < 10 || reason.length > 200) {
            return fail(400, 'VALIDATION_ERROR', 'A reason of 10 to 200 characters is required to abandon a goal.');
        }
    }

    return pass();
}

// G7: which statuses may still be edited
function canEdit(goal) {
    return goal.status === STATUS.DRAFT || isActiveLike(goal.status)
        ? pass()
        : fail(409, 'GOAL_LOCKED', `A ${goal.status} goal can no longer be edited.`);
}

// G8: which statuses may be deleted
function canDelete(goal) {
    return goal.status === STATUS.DRAFT || goal.status === STATUS.ABANDONED
        ? pass()
        : fail(409, 'GOAL_LOCKED', 'Only Draft or Abandoned goals can be deleted. Abandon it first.');
}

/**
 * G6: how healthy a goal is, compared with where it should be by now.
 * expected = share of the time between start and deadline that has passed.
 * @returns { health: 'OnTrack' | 'AtRisk' | 'Overdue' | 'Done' | 'NotStarted', expected }
 */
function computeHealth({ status, progress, startedAt, deadline, now }) {
    if (status === STATUS.ACHIEVED) return { health: 'Done', expected: 100 };
    if (!isActiveLike(status)) return { health: 'NotStarted', expected: 0 };

    const start = Date.parse(startedAt);
    const end = endOfDay(deadline);
    const t = now.getTime();

    if (t > end) {
        return { health: progress >= 100 ? 'Done' : 'Overdue', expected: 100 };
    }

    const span = Math.max(end - start, DAY_MS);
    const expected = clamp(((t - start) / span) * 100, 0, 100);
    const health = progress >= expected - HEALTH_TOLERANCE ? 'OnTrack' : 'AtRisk';
    return { health, expected: Math.round(expected) };
}

// Which status the daily scan should store for an Active or AtRisk goal
function statusFromHealth(currentStatus, health) {
    if (!isActiveLike(currentStatus)) return currentStatus;
    return health === 'AtRisk' || health === 'Overdue' ? STATUS.AT_RISK : STATUS.ACTIVE;
}

// ---- small helpers ----
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function yearOf(date) { return date.getUTCFullYear(); }
function endOfDay(isoDate) { return Date.parse(`${isoDate}T23:59:59.999Z`); }

module.exports = {
    STATUS,
    MAX_ACTIVE_GOALS,
    HEALTH_TOLERANCE,
    isActiveLike,
    checkTransition,
    canEdit,
    canDelete,
    computeHealth,
    statusFromHealth,
    yearOf
};
