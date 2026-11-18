#!/usr/bin/env bash
# ---------------------------------------------------------------
# Deploy the Goals Service to Floci (or real AWS: change the profile).
# Safe to run again: it creates what is missing and updates the rest.
# Run from this repo's folder in Git Bash:   bash scripts/deploy.sh
#
# Needs the shared base first (okr18-frontend: bash infra/shared-setup.sh),
# which writes the ids this script reads (API, topic, Cognito).
# ---------------------------------------------------------------
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
SHARED_VARS="${SHARED_VARS:-../okr18-frontend/infra/okr18-vars.sh}"

TABLE=Goals
ROLE=goals-role
SCHED_ROLE=goals-scheduler-role
FN_API=goals-api
FN_INTERNAL=goals-internal
FN_SCAN=goals-health-scan
KR_FN=kr-internal

if [ -f "$SHARED_VARS" ]; then
  # shellcheck source=/dev/null
  source "$SHARED_VARS"
  echo "Shared base: $SHARED_VARS"
else
  echo "WARNING: $SHARED_VARS not found. Run the shared setup first; deploying without API routes."
fi

# The policies are written for Floci's account 000000000000; swap in the real one if different
policy_file() { sed "s/000000000000/$ACCOUNT/g; s/us-east-1/$REGION/g" "$1" > "out/$(basename "$1")"; echo "file://out/$(basename "$1")"; }
mkdir -p out

echo "1/7 DynamoDB table $TABLE (+ index userId-year-index, KMS encryption)"
if ! aws dynamodb describe-table --table-name $TABLE > /dev/null 2>&1; then
  aws dynamodb create-table --table-name $TABLE \
    --attribute-definitions AttributeName=goalId,AttributeType=S AttributeName=userId,AttributeType=S AttributeName=year,AttributeType=N \
    --key-schema AttributeName=goalId,KeyType=HASH \
    --global-secondary-indexes "IndexName=userId-year-index,KeySchema=[{AttributeName=userId,KeyType=HASH},{AttributeName=year,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
    --billing-mode PAY_PER_REQUEST \
    --sse-specification Enabled=true,SSEType=KMS > /dev/null
  aws dynamodb wait table-exists --table-name $TABLE
fi

echo "2/7 IAM: $ROLE (own table, own topic, kr-internal, own metrics, own logs) and $SCHED_ROLE"
aws iam get-role --role-name $ROLE > /dev/null 2>&1 || \
  aws iam create-role --role-name $ROLE --assume-role-policy-document file://infra/iam/trust-policy.json > /dev/null
aws iam put-role-policy --role-name $ROLE --policy-name goals-access --policy-document "$(policy_file infra/iam/goals-policy.json)"
aws iam get-role --role-name $SCHED_ROLE > /dev/null 2>&1 || \
  aws iam create-role --role-name $SCHED_ROLE --assume-role-policy-document file://infra/iam/scheduler-trust-policy.json > /dev/null
aws iam put-role-policy --role-name $SCHED_ROLE --policy-name invoke-health-scan --policy-document "$(policy_file infra/iam/scheduler-policy.json)"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"

echo "3/7 Install and zip"
npm install --omit=dev --no-audit --no-fund --loglevel=error
npm run zip --silent

# Lambda environment variables as a JSON file: the CLI's short form breaks on values that
# contain commas (CORS_ORIGINS has two addresses), JSON does not.
write_env() {   # KEY=VALUE ...  ->  out/env.json
  node -e 'const v={};for(const kv of process.argv.slice(1)){const i=kv.indexOf("=");v[kv.slice(0,i)]=kv.slice(i+1);}require("fs").writeFileSync("out/env.json",JSON.stringify({Variables:v}));' "$@"
}
write_env NODE_ENV=production "GOALS_TABLE=$TABLE" "KR_INTERNAL_FUNCTION=$KR_FN" "EVENTS_TOPIC_ARN=${EVENTS_TOPIC_ARN:-}" \
  "COGNITO_ISSUER=${COGNITO_ISSUER:-}" "COGNITO_JWKS_URI=${COGNITO_JWKS_URI:-}" "COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID:-}" \
  "ALLOW_HTTP_JWKS=${ALLOW_HTTP_JWKS:-true}" "CORS_ORIGINS=${CORS_ORIGINS:-http://localhost:8080}"

deploy_fn() {   # name handler
  if aws lambda get-function --function-name "$1" > /dev/null 2>&1; then
    aws lambda update-function-code --function-name "$1" --zip-file fileb://lambda.zip > /dev/null
    aws lambda wait function-updated-v2 --function-name "$1"
    aws lambda update-function-configuration --function-name "$1" --handler "$2" --environment file://out/env.json > /dev/null
  else
    aws lambda create-function --function-name "$1" --runtime nodejs24.x --handler "$2" \
      --role "$ROLE_ARN" --zip-file fileb://lambda.zip --timeout 10 --memory-size 128 \
      --environment file://out/env.json > /dev/null
  fi
  aws lambda wait function-active-v2 --function-name "$1"
  aws logs create-log-group --log-group-name "/aws/lambda/$1" > /dev/null 2>&1 || true
  aws logs put-retention-policy --log-group-name "/aws/lambda/$1" --retention-in-days 7 > /dev/null 2>&1 || true
  echo "   $1 ready"
}

echo "4/7 Lambda functions"
deploy_fn $FN_API handlers/api.handler
deploy_fn $FN_INTERNAL handlers/internal.handler
deploy_fn $FN_SCAN handlers/healthScan.handler

echo "5/7 API Gateway routes (only these reach goals-api)"
if [ -n "${API_ID:-}" ]; then
  FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN_API"
  INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
    --query "Items[?IntegrationUri=='$FN_ARN'].IntegrationId | [0]" --output text)
  if [ "$INTEGRATION_ID" = "None" ] || [ -z "$INTEGRATION_ID" ]; then
    INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
      --payload-format-version 2.0 --integration-uri "$FN_ARN" --query IntegrationId --output text)
  fi
  EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[].RouteKey" --output text)
  add_route() {   # "METHOD path" protected(yes/no)
    if printf '%s\n' "$EXISTING" | tr '\t' '\n' | grep -Fxq "$1"; then return; fi   # exact match only
    if [ "$2" = yes ] && [ -n "${AUTHORIZER_ID:-}" ]; then
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$INTEGRATION_ID" \
        --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" --query RouteKey --output text
    else
      aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$INTEGRATION_ID" \
        --query RouteKey --output text
    fi
  }
  add_route "GET /api/goals/health" no
  add_route "GET /api/goals" yes
  add_route "POST /api/goals" yes
  add_route "GET /api/goals/summary" yes
  add_route "GET /api/goals/{id}" yes
  add_route "PATCH /api/goals/{id}" yes
  add_route "DELETE /api/goals/{id}" yes
  add_route "POST /api/goals/{id}/transitions" yes
  # CORS preflight: the browser asks OPTIONS first for requests with a token; Express cors() answers
  add_route "OPTIONS /api/goals" no
  add_route "OPTIONS /api/goals/summary" no
  add_route "OPTIONS /api/goals/{id}" no
  add_route "OPTIONS /api/goals/{id}/transitions" no
  aws lambda add-permission --function-name $FN_API --statement-id apigw-invoke-goals \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" > /dev/null 2>&1 || true
else
  echo "   skipped: API_ID unknown"
fi

echo "6/7 EventBridge Scheduler: health scan every day at 06:00 Cairo time"
SCHED_ARGS=(--name goals-daily-health --schedule-expression "cron(0 6 * * ? *)" \
  --schedule-expression-timezone Africa/Cairo --flexible-time-window Mode=OFF \
  --target "Arn=arn:aws:lambda:$REGION:$ACCOUNT:function:$FN_SCAN,RoleArn=arn:aws:iam::$ACCOUNT:role/$SCHED_ROLE")
aws scheduler create-schedule "${SCHED_ARGS[@]}" > /dev/null 2>&1 || \
  aws scheduler update-schedule "${SCHED_ARGS[@]}" > /dev/null

echo "7/7 Smoke test: health route through Lambda"
aws lambda invoke --function-name $FN_API --payload file://events/1-health.json \
  --cli-binary-format raw-in-base64-out out/health.json > /dev/null
cat out/health.json; echo
echo "Done. Saved events to try: ls events/"
