// Unit tests for the business rules. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { STATUS, checkTransition, canEdit, canDelete, computeHealth, statusFromHealth } = require('../src/rules');
const { validateNewGoal, validateEdit, validateListQuery } = require('../src/validate');

const now = new Date('2026-06-01T12:00:00Z');
const goal = (over = {}) => ({ status: STATUS.DRAFT, year: 2026, reopened: false, ...over });
const facts = (over = {}) => ({ keyResultCount: 2, progress: 0, activeGoalsThisYear: 0, reason: '', now, ...over });

test('G1: Draft can be activated, but not achieved directly', () => {
    assert.equal(checkTransition(goal(), STATUS.ACTIVE, facts()).ok, true);
    const r = checkTransition(goal(), STATUS.ACHIEVED, facts({ progress: 100 }));
    assert.equal(r.code, 'INVALID_TRANSITION');
});

test('G1: a user can never set AtRisk, and Achieved is final', () => {
    assert.equal(checkTransition(goal({ status: STATUS.ACTIVE }), STATUS.AT_RISK, facts()).code, 'INVALID_TRANSITION');
    assert.equal(checkTransition(goal({ status: STATUS.ACHIEVED }), STATUS.ACTIVE, facts()).code, 'INVALID_TRANSITION');
});

test('G2: activation needs at least one key result', () => {
    const r = checkTransition(goal(), STATUS.ACTIVE, facts({ keyResultCount: 0 }));
    assert.deepEqual([r.status, r.code], [409, 'NO_KEY_RESULTS']);
});

test('G3: a 6th active goal is refused', () => {
    assert.equal(checkTransition(goal(), STATUS.ACTIVE, facts({ activeGoalsThisYear: 4 })).ok, true);
    assert.equal(checkTransition(goal(), STATUS.ACTIVE, facts({ activeGoalsThisYear: 5 })).code, 'GOAL_LIMIT');
});

test('G4: achieved only at 100% progress', () => {
    const active = goal({ status: STATUS.ACTIVE });
    assert.equal(checkTransition(active, STATUS.ACHIEVED, facts({ progress: 99.9 })).code, 'NOT_COMPLETE');
    assert.equal(checkTransition(active, STATUS.ACHIEVED, facts({ progress: 100 })).ok, true);
    assert.equal(checkTransition(goal({ status: STATUS.AT_RISK }), STATUS.ACHIEVED, facts({ progress: 100 })).ok, true);
});

test('G5: abandoning needs a 10 to 200 character reason', () => {
    const active = goal({ status: STATUS.ACTIVE });
    assert.equal(checkTransition(active, STATUS.ABANDONED, facts({ reason: 'too short' })).status, 400);
    assert.equal(checkTransition(active, STATUS.ABANDONED, facts({ reason: 'x'.repeat(201) })).status, 400);
    assert.equal(checkTransition(active, STATUS.ABANDONED, facts({ reason: 'Changed my study plan' })).ok, true);
});

test('G5: reopen once, in the same year, still needing key results and a free slot', () => {
    const abandoned = goal({ status: STATUS.ABANDONED });
    assert.equal(checkTransition(abandoned, STATUS.ACTIVE, facts()).ok, true);
    assert.equal(checkTransition({ ...abandoned, reopened: true }, STATUS.ACTIVE, facts()).code, 'REOPEN_NOT_ALLOWED');
    assert.equal(checkTransition({ ...abandoned, year: 2025 }, STATUS.ACTIVE, facts()).code, 'REOPEN_NOT_ALLOWED');
    assert.equal(checkTransition(abandoned, STATUS.ACTIVE, facts({ activeGoalsThisYear: 5 })).code, 'GOAL_LIMIT');
});

test('G7 and G8: edit and delete windows', () => {
    assert.equal(canEdit(goal({ status: STATUS.AT_RISK })).ok, true);
    assert.equal(canEdit(goal({ status: STATUS.ACHIEVED })).code, 'GOAL_LOCKED');
    assert.equal(canDelete(goal({ status: STATUS.ABANDONED })).ok, true);
    assert.equal(canDelete(goal({ status: STATUS.ACTIVE })).code, 'GOAL_LOCKED');
});

test('G6: health compares progress with time passed', () => {
    // started 1 Jan, deadline 31 Dec: on 1 June about 41% of the time has passed
    const base = { status: STATUS.ACTIVE, startedAt: '2026-01-01T00:00:00Z', deadline: '2026-12-31', now };
    assert.equal(computeHealth({ ...base, progress: 35 }).health, 'OnTrack');   // within 10 points
    assert.equal(computeHealth({ ...base, progress: 20 }).health, 'AtRisk');
    assert.equal(computeHealth({ ...base, deadline: '2026-05-31', progress: 80 }).health, 'Overdue');
    assert.equal(computeHealth({ ...base, status: STATUS.DRAFT, progress: 0 }).health, 'NotStarted');
});

test('G6: the scan moves Active to AtRisk and back, and leaves other statuses alone', () => {
    assert.equal(statusFromHealth(STATUS.ACTIVE, 'AtRisk'), STATUS.AT_RISK);
    assert.equal(statusFromHealth(STATUS.AT_RISK, 'OnTrack'), STATUS.ACTIVE);
    assert.equal(statusFromHealth(STATUS.ACTIVE, 'Overdue'), STATUS.AT_RISK);
    assert.equal(statusFromHealth(STATUS.ABANDONED, 'AtRisk'), STATUS.ABANDONED);
});

test('validation: a good new goal passes and extra fields are dropped', () => {
    const r = validateNewGoal({ title: ' Run a 10k ', category: 'Health', year: 2026, deadline: '2026-10-01', status: 'Achieved', userId: 'someone-else' }, now);
    assert.deepEqual(r.value, { title: 'Run a 10k', description: '', category: 'Health', year: 2026, deadline: '2026-10-01' });
});

test('validation: bad fields are each reported', () => {
    const r = validateNewGoal({ title: 'x', category: 'Fun', year: 2030, deadline: 'soon' }, now);
    assert.equal(r.errors.length, 3);
    assert.match(validateNewGoal({ title: 'Read 12 books', category: 'Learning', year: 2026, deadline: '2026-02-31' }, now).errors[0], /real date/);
    assert.match(validateNewGoal({ title: 'Read 12 books', category: 'Learning', year: 2026, deadline: '2026-03-01' }, now).errors[0], /past/);
    assert.match(validateNewGoal({ title: 'Read 12 books', category: 'Learning', year: 2026, deadline: '2027-01-10' }, now).errors[0], /inside 2026/);
});

test('validation: edit needs at least one allowed field', () => {
    assert.ok(validateEdit({ status: 'Achieved' }, goal(), now).errors);
    assert.deepEqual(validateEdit({ title: 'New title' }, goal(), now).value, { title: 'New title' });
});

test('validation: list filters', () => {
    assert.deepEqual(validateListQuery({}, now).value, { year: 2026, status: undefined, category: undefined });
    assert.ok(validateListQuery({ status: 'Finished' }, now).errors);
});
