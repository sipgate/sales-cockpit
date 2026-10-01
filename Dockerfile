# Nautilus-Image für sales-cockpit (Muster: growth-cockpit /
# sipgate/sona-monitor). Build läuft in .github/workflows/nautilus-build.yaml;
# das Build-Secret `npm_token` (read:packages; im CI das github.token des
# Runs) wird als BuildKit-Secret hereingereicht und nur in der deps-Stage
# als _authToken für npm.pkg.github.com in die stage-lokale /root/.npmrc
# geschrieben (Token landet nicht im Image).

FROM node:22-alpine AS deps
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN --mount=type=secret,id=npm_token \
  printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/npm_token)" >> /root/.npmrc && \
  npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PRIVATE_STANDALONE=true
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER 65532:65532
EXPOSE 8080/tcp
CMD ["node", "server.js"]
