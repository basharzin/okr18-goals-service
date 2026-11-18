# Goals Service: API contract

Owner: Bashar Zain. Base path: `/api/goals`. All bodies are JSON (`Content-Type: application/json`, max 10 kB).
Every route except `/api/goals/health` needs `Authorization: Bearer <Cognito access token>`.
The user is always the token's `sub`; nothing in the body can change the owner, the id or the status.

Error shape (shared by all three services):

```json
{ "error": { "code": "GOAL_LIMIT", "message": "You already have 5 active goals for 2026.", "details": ["..."] } }
```

## Goal object

| Field | Type | Set by | Notes |
| --- | --- | --- | --- |
| goalId | string `G-<uuid>` | server | |
| userId | string | server (token `sub`) | |
| title | string 3–80 | client | |
| description | string 0–500 | client | optional |
| category | Health, Career, Learning, Finance, Personal, Other | client | |
| year | number | client | this year or next |
| deadline | `YYYY-MM-DD` | client | inside `year`, not in the past |
| status | Draft, Active, AtRisk, Achieved, Abandoned | server | AtRisk only by the daily scan |
| reopened | boolean | server | an abandoned goal can be reopened once |
| abandonReason | string 10–200 | client, through a transition | |
| createdAt, updatedAt, activatedAt, achievedAt | ISO time | server | |
| progress | 0–100 | Key Results | added on read, never stored here |
| health | OnTrack, AtRisk, Overdue, Done, NotStarted | server (rule G6) | added on read |
| expectedProgress | 0–100 | server | where the goal should be by now |

## Endpoints

| Method and path | Body | Success | Errors |
| --- | --- | --- | --- |
| GET /api/goals/health | | 200 `{status:"ok"}` | |
| POST /api/goals | title, description?, category, year, deadline | 201 goal (Draft) | 400 VALIDATION_ERROR, 401, 413, 415 |
| GET /api/goals?year=&status=&category= | | 200 goal[] with progress and health, nearest deadline first | 400, 401, 503 |
| GET /api/goals/summary?year= | | 200 `{year, counts, averageProgress, needsAttention[]}` | 400, 401, 503 |
| GET /api/goals/{id} | | 200 goal with progress and health | 401, 404 GOAL_NOT_FOUND (also for another user's goal) |
| PATCH /api/goals/{id} | any of title, description, category, deadline | 200 goal | 400, 401, 404, 409 GOAL_LOCKED (Achieved or Abandoned), 409 CONFLICT |
| POST /api/goals/{id}/transitions | `{ to, reason? }` | 200 goal | 400, 401, 404, 409 INVALID_TRANSITION, NO_KEY_RESULTS, GOAL_LIMIT, NOT_COMPLETE, REOPEN_NOT_ALLOWED, CONFLICT, 503 |
| DELETE /api/goals/{id} | | 204 | 401, 404, 409 GOAL_LOCKED (only Draft or Abandoned) |

Allowed transitions: Draft → Active; Active or AtRisk → Achieved or Abandoned; Abandoned → Active (reopen, once, same year).

## What Goals needs from Key Results (direct Lambda invoke of `kr-internal`)

| Request | Answer | Used for |
| --- | --- | --- |
| `{ "action": "countKeyResults", "goalId": "G-..." }` | `{ "count": 2 }` | G2: activate needs at least 1 |
| `{ "action": "getGoalsProgress", "goalIds": ["G-...", "G-..."] }` | `{ "progress": { "G-...": 62.5 } }` weighted 0–100; missing id = 0 | list, summary, achieve (G4), daily scan (G6) |

If `kr-internal` fails or cannot be reached, Goals answers 503 DEPENDENCY_UNAVAILABLE and changes nothing.

## What Goals offers the other services (direct Lambda invoke of `goals-internal`)

| Request | Answer |
| --- | --- |
| `{ "action": "getGoalStatus", "goalId": "G-..." }` | `{ "found": true, "userId": "...", "status": "Active", "year": 2026 }` or `{ "found": false }` |

Callers compare `userId` with their own caller's token `sub` (ownership) and check `status` (Key Results K4, Check-ins C1).
IAM: `kr-role` and `checkins-role` need `lambda:InvokeFunction` on `goals-internal`.

## Events Goals publishes (SNS topic `okr-events`, message attribute `eventType`)

Envelope: `{ "type", "goalId", "userId", "at", "data" }`

| type | When | data | Who listens |
| --- | --- | --- | --- |
| goal.activated | Draft → Active | `{from, to}` | (optional) Check-ins |
| goal.reopened | Abandoned → Active | `{from, to}` | Key Results (unfreeze) |
| goal.achieved | → Achieved | `{from, to}` | Check-ins (digest) |
| goal.abandoned | → Abandoned | `{from, to}` | Key Results (freeze, K8) |
| goal.deleted | DELETE | `{}` | Key Results (delete its key results, K8) |
| goal.at_risk | daily scan, Active → AtRisk | `{progress, expected, health}` | Check-ins (stalled nudge, C5) |
| goal.back_on_track | daily scan, AtRisk → Active | `{progress, expected, health}` | Check-ins (clear nudge) |

Subscribe your queue with a filter policy on `eventType`, for example
`{"eventType": ["goal.deleted", "goal.abandoned", "goal.reopened"]}`.
