# Raw Steak Validator

IOTA Mainnet Validator — staking dApp & infrastructure.

Live at [raw-steak.eu](https://raw-steak.eu)

## Structure

```
website/    Staking dApp source (React + Vite)
docker/     Dockerfile, Caddyfile, docker-compose
scripts/    Deployment script
```

## Deploy

Clone on the server and run:

```bash
bash scripts/deploy.sh
```

This builds the website inside Docker (multi-stage: node build + caddy serve) and starts the container. No node/npm needed on the server.
