// ---------------------------------------------------------------
// Lambda: goals-internal. Called by other services with a direct Lambda
// invoke, never through API Gateway, so there is no public route to it.
// IAM decides who may call it (kr-role and checkins-role).
//
//   { action: 'getGoalStatus', goalId } -> { found, userId, status, year }
// ---------------------------------------------------------------
require('dotenv').config({ quiet: true });
const { createGoalsRepo } = require('../src/goalsRepo');

let repo;   // created once per container, reused while it is warm

module.exports.handler = async (event) => {
    repo = repo || createGoalsRepo();
    if (event?.action !== 'getGoalStatus' || typeof event.goalId !== 'string') {
        return { error: 'UNKNOWN_ACTION' };
    }
    const goal = await repo.getById(event.goalId);
    if (!goal) return { found: false };
    return { found: true, userId: goal.userId, status: goal.status, year: goal.year };
};
