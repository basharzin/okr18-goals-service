// In-memory stand-ins for DynamoDB, Key Results and SNS, with the same
// methods and the same conditional behaviour as the real ones.
function fakeRepo() {
    const rows = new Map();
    const copy = (x) => (x ? structuredClone(x) : null);
    return {
        rows,
        async create(goal) { rows.set(goal.goalId, copy(goal)); return goal; },
        async getOwned(id, userId) { const g = rows.get(id); return g && g.userId === userId ? copy(g) : null; },
        async getById(id) { return copy(rows.get(id)); },
        async listForUser(userId, { year, status, category }) {
            return [...rows.values()].filter((g) => g.userId === userId && g.year === year
                && (!status || g.status === status) && (!category || g.category === category)).map(copy);
        },
        async countActive(userId, year) {
            return [...rows.values()].filter((g) => g.userId === userId && g.year === year
                && (g.status === 'Active' || g.status === 'AtRisk')).length;
        },
        async updateFields(id, userId, fields, expected, nowIso) {
            const g = rows.get(id);
            if (!g || g.userId !== userId || g.status !== expected) return null;
            Object.assign(g, fields, { updatedAt: nowIso });
            return copy(g);
        },
        async changeStatus(id, { from, to, extra = {}, nowIso, userId }) {
            const g = rows.get(id);
            if (!g || g.status !== from || (userId && g.userId !== userId)) return null;
            Object.assign(g, extra, { status: to, updatedAt: nowIso });
            return copy(g);
        },
        async remove(id, userId) {
            const g = rows.get(id);
            if (!g || g.userId !== userId || !['Draft', 'Abandoned'].includes(g.status)) return false;
            rows.delete(id);
            return true;
        },
        async listInPlay() { return [...rows.values()].filter((g) => g.status === 'Active' || g.status === 'AtRisk').map(copy); }
    };
}

function fakeKr() {
    const state = { counts: {}, progress: {}, down: false };
    const check = () => { if (state.down) { const { DependencyError } = require('../src/krClient'); throw new DependencyError('Key Results could not be reached (test).'); } };
    return {
        state,
        async countKeyResults(id) { check(); return state.counts[id] || 0; },
        async getGoalsProgress(ids) { check(); return Object.fromEntries(ids.map((id) => [id, state.progress[id] || 0])); }
    };
}

function fakeEvents() {
    const sent = [];
    return { sent, async publish(type, goal, data) { sent.push({ type, goalId: goal.goalId, data }); } };
}

// Token "token-<name>" belongs to user <name>; anything else is rejected
async function fakeVerify(token) {
    const m = /^token-(\w+)$/.exec(token);
    if (!m) throw new Error('bad token');
    return { sub: `user-${m[1]}`, 'cognito:groups': ['user'] };
}

module.exports = { fakeRepo, fakeKr, fakeEvents, fakeVerify };
