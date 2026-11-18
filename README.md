# okr18-goals-service

Team 18 OKR Tracker: the **Goals Service** (owner: Bashar Zain).
Goals owns the goal lifecycle and its health. It asks Key Results for progress
and announces every state change as an event.

## What it does

| Rule | Summary |
| --- | --- |
| G1 | Draft → Active → Achieved or Abandoned; the daily scan moves Active ↔ AtRisk |
| G2 | A goal needs at least one key result to become Active (asks Key Results) |
| G3 | At most 5 Active or AtRisk goals per user per year |
| G4 | Achieved only at 100% weighted progress (asks Key Results) |
| G5 | Abandon needs a 10–200 character reason; reopen once, same year |
| G6 | Health = progress compared with time passed; 10 points of tolerance |
| G7 | Edit only while Draft, Active or AtRisk; deadline inside the goal's year |
| G8 | Delete only Draft or Abandoned; sends goal.deleted |

Endpoints, internal calls and events: [docs/api-contract-goals.md](docs/api-contract-goals.md).

## Layout

```
app.js                 the Express app wired to AWS (no listen)
server.js              runs it on a PC: npm run dev  (port 3001)
handlers/api.js        Lambda goals-api (API Gateway -> Express via serverless-http)
handlers/internal.js   Lambda goals-internal (getGoalStatus, direct invoke only)
handlers/healthScan.js Lambda goals-health-scan (EventBridge Scheduler, daily 06:00)
jobs/healthScan.js     the scan logic (G6)
src/rules.js           business rules G1-G8, pure functions
src/validate.js        input validation
src/goalsController.js request -> rules -> data -> response
src/goalsRepo.js       the only file that talks to DynamoDB
src/krClient.js        calls kr-internal
src/events.js          publishes to SNS okr-events
src/auth.js            Cognito token -> req.user (sub + groups)
src/metrics.js         CloudWatch metric GoalsAtRisk
infra/iam/             goals-role and scheduler role policies (least privilege)
scripts/deploy.sh      creates or updates everything on Floci
scripts/zip-lambda.js  builds lambda.zip (no .env, no tests)
events/                saved Lambda events for testing
test/                  unit and endpoint tests (npm test)
```

## AWS services used here

Lambda (3 functions), DynamoDB (table Goals, KMS-encrypted, index userId-year-index),
API Gateway (8 routes, JWT check), EventBridge Scheduler (daily scan), SNS (goal events),
CloudWatch (logs kept 7 days, metric OKR18/Goals GoalsAtRisk), IAM (goals-role, goals-scheduler-role).

## Run the tests

```
npm install
npm test
```

## Deploy to Floci

1. Docker Desktop running, Floci started (`okr18-frontend`: `docker compose -f infra/floci/docker-compose.yml up -d`).
2. Shared base done once (`okr18-frontend`: `bash infra/shared-setup.sh`).
3. From this folder in Git Bash: `bash scripts/deploy.sh`

The last step prints the health answer from Lambda. Try the saved events in `events/`.
