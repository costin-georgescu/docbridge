# Local development

```sh
cp .env.example .env
pnpm dev          # docker compose up (add -d to detach)
pnpm dev:down     # stop
pnpm dev:reset    # stop and wipe volumes
```

Ports: api 3000, auth 3001, platform 3002 (all expose `/health`), web 5173,
Postgres 5432, LocalStack 4566.

To hit LocalStack from the host use `AWS_ENDPOINT_URL=http://localhost:4566`
with `aws`/`awslocal`, e.g.
`aws --endpoint-url http://localhost:4566 sqs list-queues`.
