// Lambda: goals-health-scan. EventBridge Scheduler runs it every day at 06:00.
require('dotenv').config({ quiet: true });
const { runHealthScan } = require('../jobs/healthScan');
const { createGoalsRepo } = require('../src/goalsRepo');
const { createKrClient } = require('../src/krClient');
const { createEvents } = require('../src/events');
const { createMetrics } = require('../src/metrics');

module.exports.handler = async () => runHealthScan({
    repo: createGoalsRepo(),
    kr: createKrClient(),
    events: createEvents(),
    metrics: createMetrics(),
    now: new Date()
});
