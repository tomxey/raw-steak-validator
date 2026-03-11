FROM node:20-alpine AS build
WORKDIR /app
COPY website/package.json website/package-lock.json ./
RUN npm ci
COPY website/ .
RUN npm run build

FROM caddy:alpine
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
