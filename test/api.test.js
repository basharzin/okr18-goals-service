// Endpoint tests: the real Express app and controller, with fakes behind them.
// They cover the functional cases and the security tests ST1, ST3, ST5 (413) for Goals.
const test = require('node:test');
const assert = require('node:assert/strict');
const serverless = require('serverless-http');
const { createApp } = require('../src/createApp');
const { runHealthScan } = require('../jobs/healthScan');
const { fakeRepo, fakeKr, fakeEvents, fakeVerify } = require('../test-support/fakes');

const NOW = new Date('2026-06-01T12:00:00Z');

function setup() {
    const repo = fakeRepo(); const kr = fakeKr(); const events = fakeEvents();
    const app = createApp({ repo, kr, events, verify: fakeVerify, now: () => NOW });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/goals`;
    const call = async (method, path, { user = 'a', body, raw, type = 'application/json' } = {}) => {
        const headers = {};
        if (user) headers.authorization = `Bearer token-${user}`;
        if (body !== undefined || raw !== undefined) headers['content-type'] = type;
        const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return { repo, kr, events, server, call, app };
}

const newGoal = { title: 'Run a 10k race', category: 'Health', year: 2026, deadline: '2026-12-31' };

test('ST1: no token or a bad token gets 401', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    assert.equal((await call('GET', '', { user: null })).status, 401);
    const bad = await fetch(`http://127.0.0.1:${server.address().port}/api/goals`, { headers: { authorization: 'Bearer forged' } });
    assert.equal(bad.status, 401);
});

test('create: 201, server-owned fields are set by the server', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    const r = await call('POST', '', { body: { ...newGoal, status: 'Achieved', userId: 'user-b', goalId: 'G-x' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, 'Draft');
    assert.equal(r.body.userId, 'user-a');
    assert.match(r.body.goalId, /^G-[0-9a-f-]{36}$/);
});

test('create: invalid input gets 400, non-JSON gets 415, broken JSON 400, huge body 413', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    const r = await call('POST', '', { body: { title: 'x', category: 'Fun', year: 2026, deadline: '2026-13-01' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    assert.ok(r.body.error.details.length >= 3);
    assert.equal((await call('POST', '', { raw: 'title=x', type: 'text/plain' })).status, 415);
    assert.equal((await call('POST', '', { raw: '{"title": ' })).status, 400);
    assert.equal((await call('POST', '', { raw: JSON.stringify({ title: 'x'.repeat(20000) }) })).status, 413);
});

test('ST3: user B cannot read, edit, move or delete user A\'s goal (404 each)', async (t) => {
    const { server, call, repo } = setup(); t.after(() => server.close());
    const { body: g } = await call('POST', '', { body: newGoal });
    assert.equal((await call('GET', `/${g.goalId}`, { user: 'b' })).status, 404);
    assert.equal((await call('PATCH', `/${g.goalId}`, { user: 'b', body: { title: 'Hacked title' } })).status, 404);
    assert.equal((await call('POST', `/${g.goalId}/transitions`, { user: 'b', body: { to: 'Active' } })).status, 404);
    assert.equal((await call('DELETE', `/${g.goalId}`, { user: 'b' })).status, 404);
    assert.equal(repo.rows.get(g.goalId).title, 'Run a 10k race');
    assert.equal((await call('GET', '', { user: 'b' })).body.length, 0);
});

test('G2 + G3 + G4: full lifecycle with Key Results answers', async (t) => {
    const { server, call, kr, events } = setup(); t.after(() => server.close());
    const { body: g } = await call('POST', '', { body: newGoal });

    let r = await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Active' } });
    assert.deepEqual([r.status, r.body.error.code], [409, 'NO_KEY_RESULTS']);

    kr.state.counts[g.goalId] = 2;
    r = await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Active' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'Active');
    assert.equal(events.sent.at(-1).type, 'goal.activated');

    kr.state.progress[g.goalId] = 80;
    r = await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Achieved' } });
    assert.deepEqual([r.status, r.body.error.code], [409, 'NOT_COMPLETE']);

    kr.state.progress[g.goalId] = 100;
    r = await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Achieved' } });
    assert.equal(r.body.status, 'Achieved');
    assert.equal(events.sent.at(-1).type, 'goal.achieved');

    assert.equal((await call('PATCH', `/${g.goalId}`, { body: { title: 'Too late now' } })).body.error.code, 'GOAL_LOCKED');
    assert.equal((await call('DELETE', `/${g.goalId}`)).body.error.code, 'GOAL_LOCKED');
});

test('G3: the 6th active goal is refused', async (t) => {
    const { server, call, kr } = setup(); t.after(() => server.close());
    const ids = [];
    for (let i = 0; i < 6; i++) {
        const { body } = await call('POST', '', { body: { ...newGoal, title: `Goal number ${i}` } });
        kr.state.counts[body.goalId] = 1;
        ids.push(body.goalId);
    }
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', `/${ids[i]}/transitions`, { body: { to: 'Active' } })).status, 200);
    const r = await call('POST', `/${ids[5]}/transitions`, { body: { to: 'Active' } });
    assert.equal(r.body.error.code, 'GOAL_LIMIT');
});

test('G5 + G8: abandon with reason, reopen once, delete sends goal.deleted', async (t) => {
    const { server, call, kr, events, repo } = setup(); t.after(() => server.close());
    const { body: g } = await call('POST', '', { body: newGoal });
    kr.state.counts[g.goalId] = 1;
    await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Active' } });

    assert.equal((await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Abandoned' } })).status, 400);
    assert.equal((await call('DELETE', `/${g.goalId}`)).status, 409);
    const ab = await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Abandoned', reason: 'Injured my knee in May' } });
    assert.equal(ab.body.abandonReason, 'Injured my knee in May');

    assert.equal((await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Active' } })).body.reopened, true);
    await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Abandoned', reason: 'Still injured, stopping' } });
    assert.equal((await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Active' } })).body.error.code, 'REOPEN_NOT_ALLOWED');

    assert.equal((await call('DELETE', `/${g.goalId}`)).status, 204);
    assert.equal(repo.rows.has(g.goalId), false);
    assert.equal(events.sent.at(-1).type, 'goal.deleted');
});

test('a user cannot set AtRisk and an unknown status is 400', async (t) => {
    const { server, call } = setup(); t.after(() => server.close());
    const { body: g } = await call('POST', '', { body: newGoal });
    assert.equal((await call('POST', `/${g.goalId}/transitions`, { body: { to: 'AtRisk' } })).body.error.code, 'INVALID_TRANSITION');
    assert.equal((await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Done' } })).status, 400);
});

test('list, filters and summary', async (t) => {
    const { server, call, kr } = setup(); t.after(() => server.close());
    const { body: a } = await call('POST', '', { body: newGoal });
    await call('POST', '', { body: { ...newGoal, title: 'Save money monthly', category: 'Finance', deadline: '2026-08-01' } });
    kr.state.counts[a.goalId] = 1;
    await call('POST', `/${a.goalId}/transitions`, { body: { to: 'Active' } });

    const all = await call('GET', '');
    assert.equal(all.body.length, 2);
    assert.equal(all.body[0].title, 'Save money monthly');            // nearest deadline first
    assert.equal((await call('GET', '?category=Finance')).body.length, 1);
    assert.equal((await call('GET', '?status=Finished')).status, 400);

    const s = await call('GET', '/summary');
    assert.equal(s.body.counts.Active, 1);
    assert.equal(s.body.counts.Draft, 1);
    assert.equal(s.body.needsAttention.length, 0);                   // activated today, so nothing is expected yet
});

test('Key Results down: 503, nothing changed', async (t) => {
    const { server, call, kr, repo } = setup(); t.after(() => server.close());
    const { body: g } = await call('POST', '', { body: newGoal });
    kr.state.down = true;
    const r = await call('POST', `/${g.goalId}/transitions`, { body: { to: 'Active' } });
    assert.equal(r.status, 503);
    assert.equal(repo.rows.get(g.goalId).status, 'Draft');
});

test('behind API Gateway: the authorizer claims identify the user (Lambda event)', async () => {
    const repo = fakeRepo();
    const handler = serverless(createApp({ repo, kr: fakeKr(), events: fakeEvents(), verify: fakeVerify, now: () => NOW }));
    const event = {
        version: '2.0', rawPath: '/api/goals', rawQueryString: '',
        headers: { 'content-type': 'application/json' },
        requestContext: { http: { method: 'POST', path: '/api/goals', sourceIp: '127.0.0.1' }, authorizer: { jwt: { claims: { sub: 'user-gw', 'cognito:groups': '[user]' } } } },
        body: JSON.stringify(newGoal), isBase64Encoded: false
    };
    const res = await handler(event, {});
    assert.equal(res.statusCode, 201);
    assert.equal(JSON.parse(res.body).userId, 'user-gw');
});

test('daily health scan: behind schedule moves to AtRisk, catching up moves back', async () => {
    const repo = fakeRepo(); const kr = fakeKr(); const events = fakeEvents();
    const metrics = { values: {}, async put(n, v) { this.values[n] = v; } };
    await repo.create({ goalId: 'G-1', userId: 'user-a', status: 'Active', year: 2026, deadline: '2026-12-31', createdAt: '2026-01-01T00:00:00Z', activatedAt: '2026-01-01T00:00:00Z' });

    kr.state.progress['G-1'] = 10;
    let out = await runHealthScan({ repo, kr, events, metrics, now: NOW });
    assert.deepEqual(out, { scanned: 1, atRisk: 1, moved: 1 });
    assert.equal(repo.rows.get('G-1').status, 'AtRisk');
    assert.equal(events.sent.at(-1).type, 'goal.at_risk');
    assert.equal(metrics.values.GoalsAtRisk, 1);

    kr.state.progress['G-1'] = 45;
    out = await runHealthScan({ repo, kr, events, metrics, now: NOW });
    assert.equal(repo.rows.get('G-1').status, 'Active');
    assert.equal(events.sent.at(-1).type, 'goal.back_on_track');
});
