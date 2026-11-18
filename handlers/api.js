// Lambda: goals-api. API Gateway sends every /api/goals request here.
// serverless-http turns the Lambda event into an Express request and back.
const serverless = require('serverless-http');
const app = require('../app');

module.exports.handler = serverless(app);   // Lambda handler setting: handlers/api.handler
