# Payments runbook

Owner: payments platform team.

## payments-processor

Consumes payment intents and writes ledger entries. At startup it needs:

- `DATABASE_URL`: the orders database, from the `payments-db` Secret
  (key `url`). Without it the process exits with
  `Missing required env var DATABASE_URL`.
- `REDIS_HOST`: the idempotency cache, `payments-redis.payments.svc`.

If it fails at startup, check both environment variables on the Deployment
first, then the Secret reference.

## payments-ledger

Serves ledger reads. Images are published by CI as
`registry.example.com/payments/ledger:<semver>`; a tag that CI never pushed
leaves the pod in `ImagePullBackOff`. Roll back to the previous tag in the
Deployment.

## payments-gateway

The public API. Healthy when every replica is Ready; it has no startup
dependencies beyond its own config.
