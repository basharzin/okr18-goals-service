# Saved events

`1-` to `7-` are API Gateway (HTTP API, payload 2.0) events for `goals-api`.
The `authorizer.jwt.claims` block is what API Gateway adds after it checks a
Cognito token, so these test the service without logging in.
Only someone allowed to call `lambda:Invoke` (an IAM permission) can send
them directly; the public path is always API Gateway, which checks the token.

To transition or edit a goal, copy `2-create-goal.json`, change `rawPath`,
`requestContext.http.method`/`path` and `body`, and use the goalId that 2 returned.

    aws lambda invoke --function-name goals-api --payload file://events/2-create-goal.json \
      --cli-binary-format raw-in-base64-out out/r.json && cat out/r.json

`internal-get-goal-status.json` is for `goals-internal`, `scan.json` for `goals-health-scan`.
