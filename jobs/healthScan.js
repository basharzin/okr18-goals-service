// ---------------------------------------------------------------
// Daily health scan (rule G6).
// For every Active or AtRisk goal: get its progress from Key Results,
// compare it with where it should be by now, and move it between
// Active and AtRisk. Each move becomes an event, so Check-ins can nudge
// the user. The number of goals at risk is written as a CloudWatch metric.
// ---------------------------------------------------------------
const { computeHealth, statusFromHealth } = require('../src/rules');

async function runHealthScan({ repo, kr, events, metrics, now }) {
    const goals = await repo.listInPlay();
    const progress = await kr.getGoalsProgress(goals.map((g) => g.goalId));
    const iso = now.toISOString();
    let atRisk = 0;
    let moved = 0;

    for (const goal of goals) {
        const p = Number(progress[goal.goalId] || 0);
        const { health, expected } = computeHealth({
            status: goal.status, progress: p, startedAt: goal.activatedAt || goal.createdAt, deadline: goal.deadline, now
        });
        const next = statusFromHealth(goal.status, health);
        if (next === 'AtRisk') atRisk += 1;
        if (next === goal.status) continue;

        // Only moves the goal if nobody changed it since we read it
        const updated = await repo.changeStatus(goal.goalId, { from: goal.status, to: next, nowIso: iso });
        if (!updated) continue;
        moved += 1;
        await events.publish(next === 'AtRisk' ? 'goal.at_risk' : 'goal.back_on_track', updated, { progress: Math.round(p), expected, health });
    }

    await metrics.put('GoalsAtRisk', atRisk);
    const result = { scanned: goals.length, atRisk, moved };
    console.log(JSON.stringify({ service: 'goals', job: 'health-scan', ...result }));
    return result;
}

module.exports = { runHealthScan };
