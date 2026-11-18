// ---------------------------------------------------------------
// Builds the Express app from its parts. app.js passes the real
// AWS-backed parts; the tests pass fakes.
// Order: log -> CORS -> JSON body (10 kB) -> login check -> routes -> 404 -> errors
// ---------------------------------------------------------------
const express = require('express');
const cors = require('cors');
const { requireUser } = require('./auth');
const { createGoalsController, sendError } = require('./goalsController');
const { DependencyError } = require('./krClient');

// Express 5 passes rejected promises from async handlers to the error handler
function createApp({ repo, kr, events, verify, now, allowedOrigins = [] }) {
    const app = express();
    app.disable('x-powered-by');

    // One log line per request. Never the body, never the token.
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            console.log(JSON.stringify({
                service: 'goals', method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode,
                ms: Date.now() - start, user: req.user?.id
            }));
        });
        next();
    });

    app.use(cors({ origin: allowedOrigins }));

    // Bodies must be JSON: anything else on POST/PATCH is 415
    app.use((req, res, next) => {
        if ((req.method === 'POST' || req.method === 'PATCH') && !req.is('application/json')) {
            return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.');
        }
        next();
    });
    app.use(express.json({ limit: '10kb' }));

    app.get('/api/goals/health', (req, res) => res.status(200).json({ status: 'ok', service: 'goals' }));

    const goals = createGoalsController({ repo, kr, events, now });
    const router = express.Router();
    router.use(requireUser(verify));                     // every route below needs a login
    router.post('/', goals.createGoal);
    router.get('/', goals.listGoals);
    router.get('/summary', goals.summary);               // before /:id, or "summary" would be read as an id
    router.get('/:id', goals.getGoal);
    router.patch('/:id', goals.editGoal);
    router.post('/:id/transitions', goals.transition);
    router.delete('/:id', goals.deleteGoal);
    app.use('/api/goals', router);

    app.use((req, res) => sendError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found.'));

    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        if (error.type === 'entity.parse.failed') return sendError(res, 400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
        if (error.type === 'entity.too.large') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
        if (error instanceof DependencyError) {
            console.error(JSON.stringify({ service: 'goals', dependency: error.message }));
            return sendError(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Key Results is not answering. Try again shortly.');
        }
        console.error(error);
        return sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
    });

    return app;
}

module.exports = { createApp };
