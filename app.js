// ---------------------------------------------------------------
// The real Goals app: the parts from src/ connected to AWS.
// It does not start a server. Two files use it:
//   server.js          -> runs it on a PC (npm run dev)
//   handlers/api.js    -> runs it on Lambda behind API Gateway
// ---------------------------------------------------------------
require('dotenv').config({ quiet: true });

const { createApp } = require('./src/createApp');
const { createGoalsRepo } = require('./src/goalsRepo');
const { createKrClient } = require('./src/krClient');
const { createEvents } = require('./src/events');
const { createVerifier } = require('./src/auth');

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:8080')
    .split(',').map((o) => o.trim()).filter(Boolean);

module.exports = createApp({
    repo: createGoalsRepo(),
    kr: createKrClient(),
    events: createEvents(),
    verify: createVerifier(),
    allowedOrigins
});
