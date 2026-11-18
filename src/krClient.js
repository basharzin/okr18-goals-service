// ---------------------------------------------------------------
// Talks to the Key Results service by direct Lambda invoke.
// Not over HTTP: kr-internal has no public route, and only roles that
// IAM allows (goals-role) can call it.
//
// Contract (agreed with the Key Results owner, see docs/api-contract.md):
//   { action: 'countKeyResults', goalId }            -> { count }
//   { action: 'getGoalsProgress', goalIds: [...] }   -> { progress: { <goalId>: 0..100 } }
// ---------------------------------------------------------------
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

class DependencyError extends Error {
    constructor(message) { super(message); this.name = 'DependencyError'; }
}

function createKrClient({ functionName = process.env.KR_INTERNAL_FUNCTION, client } = {}) {
    if (!functionName) {
        // Allowed on a PC only, so Goals can be built before Key Results exists.
        if (process.env.NODE_ENV === 'production') throw new Error('KR_INTERNAL_FUNCTION is not set.');
        console.warn('KR_INTERNAL_FUNCTION not set: using a local stub (1 key result, 0% progress).');
        return {
            countKeyResults: async () => 1,
            getGoalsProgress: async (ids) => Object.fromEntries(ids.map((id) => [id, 0]))
        };
    }

    const lambda = client || new LambdaClient({});

    async function call(payload) {
        let res;
        try {
            res = await lambda.send(new InvokeCommand({
                FunctionName: functionName,
                Payload: Buffer.from(JSON.stringify(payload))
            }));
        } catch (error) {
            throw new DependencyError(`Key Results could not be reached (${error.name}).`);
        }
        if (res.FunctionError) throw new DependencyError(`Key Results failed (${res.FunctionError}).`);
        return JSON.parse(Buffer.from(res.Payload).toString('utf8'));
    }

    async function countKeyResults(goalId) {
        const out = await call({ action: 'countKeyResults', goalId });
        return Number(out.count) || 0;
    }

    async function getGoalsProgress(goalIds) {
        if (goalIds.length === 0) return {};
        const out = await call({ action: 'getGoalsProgress', goalIds });
        return out.progress || {};
    }

    return { countKeyResults, getGoalsProgress };
}

module.exports = { createKrClient, DependencyError };
