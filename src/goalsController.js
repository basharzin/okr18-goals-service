// ---------------------------------------------------------------
// Goals controller: reads the request, applies the rules, calls the
// data layer and the other services, and chooses the HTTP answer.
// Dependencies are passed in (repo, kr, events, now) so tests can use fakes.
// ---------------------------------------------------------------
const { randomUUID } = require('crypto');
const { STATUS, isActiveLike, checkTransition, canEdit, canDelete, computeHealth } = require('./rules');
const { validateNewGoal, validateEdit, validateListQuery, isGoalId } = require('./validate');

const STATUS_LIST = Object.values(STATUS);

function sendError(res, status, code, message, details) {
    return res.status(status).json({ error: details ? { code, message, details } : { code, message } });
}
const notFound = (res) => sendError(res, 404, 'GOAL_NOT_FOUND', 'Goal not found.');

function createGoalsController({ repo, kr, events, now = () => new Date() }) {

    // Adds progress (from Key Results) and health (rule G6) to each goal
    async function withProgress(goals) {
        const t = now();
        const ids = goals.filter((g) => g.status !== STATUS.DRAFT).map((g) => g.goalId);
        const progress = await kr.getGoalsProgress(ids);
        return goals.map((g) => {
            const p = g.status === STATUS.ACHIEVED ? 100 : Number(progress[g.goalId] || 0);
            const { health, expected } = computeHealth({
                status: g.status, progress: p, startedAt: g.activatedAt || g.createdAt, deadline: g.deadline, now: t
            });
            return { ...g, progress: Math.round(p), health, expectedProgress: expected };
        });
    }

    // POST /api/goals
    async function createGoal(req, res) {
        const t = now();
        const { errors, value } = validateNewGoal(req.body, t);
        if (errors) return sendError(res, 400, 'VALIDATION_ERROR', errors[0], errors);
        const iso = t.toISOString();
        const goal = {
            goalId: `G-${randomUUID()}`,         // the server creates the id
            userId: req.user.id,                 // the owner comes from the token
            ...value,
            status: STATUS.DRAFT,                // every goal starts as a Draft (G1)
            reopened: false,
            createdAt: iso,
            updatedAt: iso
        };
        await repo.create(goal);
        return res.status(201).json(goal);
    }

    // GET /api/goals?year=&status=&category=
    async function listGoals(req, res) {
        const { errors, value } = validateListQuery(req.query, now());
        if (errors) return sendError(res, 400, 'VALIDATION_ERROR', errors[0], errors);
        const goals = await repo.listForUser(req.user.id, value);
        goals.sort((a, b) => a.deadline.localeCompare(b.deadline));   // nearest deadline first
        return res.status(200).json(await withProgress(goals));
    }

    // GET /api/goals/summary?year=
    async function summary(req, res) {
        const { errors, value } = validateListQuery({ year: req.query.year }, now());
        if (errors) return sendError(res, 400, 'VALIDATION_ERROR', errors[0], errors);
        const goals = await withProgress(await repo.listForUser(req.user.id, { year: value.year }));
        const counts = Object.fromEntries(STATUS_LIST.map((s) => [s, 0]));
        goals.forEach((g) => { counts[g.status] += 1; });
        const inPlay = goals.filter((g) => isActiveLike(g.status));
        const average = inPlay.length ? Math.round(inPlay.reduce((n, g) => n + g.progress, 0) / inPlay.length) : 0;
        return res.status(200).json({
            year: value.year,
            counts,
            averageProgress: average,
            needsAttention: goals
                .filter((g) => g.health === 'AtRisk' || g.health === 'Overdue')
                .map(({ goalId, title, progress, expectedProgress, health, deadline }) => ({ goalId, title, progress, expectedProgress, health, deadline }))
        });
    }

    // GET /api/goals/:id
    async function getGoal(req, res) {
        if (!isGoalId(req.params.id)) return notFound(res);
        const goal = await repo.getOwned(req.params.id, req.user.id);
        if (!goal) return notFound(res);          // also for someone else's goal
        const [withP] = await withProgress([goal]);
        return res.status(200).json(withP);
    }

    // PATCH /api/goals/:id
    async function editGoal(req, res) {
        if (!isGoalId(req.params.id)) return notFound(res);
        const goal = await repo.getOwned(req.params.id, req.user.id);
        if (!goal) return notFound(res);
        const allowed = canEdit(goal);
        if (!allowed.ok) return sendError(res, allowed.status, allowed.code, allowed.message);
        const t = now();
        const { errors, value } = validateEdit(req.body, goal, t);
        if (errors) return sendError(res, 400, 'VALIDATION_ERROR', errors[0], errors);
        const updated = await repo.updateFields(goal.goalId, req.user.id, value, goal.status, t.toISOString());
        if (!updated) return sendError(res, 409, 'CONFLICT', 'The goal changed while you were editing. Reload and try again.');
        return res.status(200).json(updated);
    }

    // POST /api/goals/:id/transitions   body: { to, reason }
    async function transition(req, res) {
        if (!isGoalId(req.params.id)) return notFound(res);
        const to = req.body?.to;
        if (!STATUS_LIST.includes(to)) {
            return sendError(res, 400, 'VALIDATION_ERROR', `to must be one of: ${STATUS_LIST.join(', ')}.`);
        }
        const goal = await repo.getOwned(req.params.id, req.user.id);
        if (!goal) return notFound(res);

        const t = now();
        const facts = { now: t, reason: req.body.reason };
        // Ask other services only for what this move needs
        if (to === STATUS.ACTIVE) {
            facts.keyResultCount = await kr.countKeyResults(goal.goalId);
            facts.activeGoalsThisYear = await repo.countActive(req.user.id, goal.year);
        }
        if (to === STATUS.ACHIEVED) {
            const progress = await kr.getGoalsProgress([goal.goalId]);
            facts.progress = Number(progress[goal.goalId] || 0);
        }

        const verdict = checkTransition(goal, to, facts);
        if (!verdict.ok) return sendError(res, verdict.status, verdict.code, verdict.message);

        const iso = t.toISOString();
        const extra = {};
        let eventType;
        if (to === STATUS.ACTIVE && goal.status === STATUS.ABANDONED) {
            Object.assign(extra, { reopened: true, activatedAt: iso, abandonReason: null });
            eventType = 'goal.reopened';
        } else if (to === STATUS.ACTIVE) {
            extra.activatedAt = iso;
            eventType = 'goal.activated';
        } else if (to === STATUS.ACHIEVED) {
            extra.achievedAt = iso;
            eventType = 'goal.achieved';
        } else if (to === STATUS.ABANDONED) {
            extra.abandonReason = req.body.reason.trim();
            eventType = 'goal.abandoned';
        }

        const updated = await repo.changeStatus(goal.goalId, { from: goal.status, to, extra, nowIso: iso, userId: req.user.id });
        if (!updated) return sendError(res, 409, 'CONFLICT', 'The goal changed meanwhile. Reload and try again.');
        await events.publish(eventType, updated, { from: goal.status, to });
        const [withP] = await withProgress([updated]);
        return res.status(200).json(withP);
    }

    // DELETE /api/goals/:id
    async function deleteGoal(req, res) {
        if (!isGoalId(req.params.id)) return notFound(res);
        const goal = await repo.getOwned(req.params.id, req.user.id);
        if (!goal) return notFound(res);
        const allowed = canDelete(goal);
        if (!allowed.ok) return sendError(res, allowed.status, allowed.code, allowed.message);
        const removed = await repo.remove(goal.goalId, req.user.id);
        if (!removed) return sendError(res, 409, 'CONFLICT', 'The goal changed meanwhile. Reload and try again.');
        await events.publish('goal.deleted', goal);   // Key Results removes this goal's key results
        return res.status(204).end();
    }

    return { createGoal, listGoals, summary, getGoal, editGoal, transition, deleteGoal };
}

module.exports = { createGoalsController, sendError };
