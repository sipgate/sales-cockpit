# PLAN: Sales Cockpit auf Nautilus-Service (Polling + Runtime-Store)

Umstellung der Datenarchitektur und des Deployments nach dem Muster des
Growth Cockpits (`~/Development/growth-cockpit`): Nautilus-Service im
Tooling-Cluster, Hintergrund-Poller im Serverprozess, Runtime-Store
(In-Memory + tmpdir-JSON) statt Request-Pfad-Fetches mit Netlify-Blobs-Cache
und Cache-Warmer.

## Ziel

- Kein Datenzugriff mehr aus View-Requests heraus. Alle Quellen
  (HubSpot, JIRA, Amplitude BigQuery) fragt ein Hintergrund-Poller auf
  festen Timern ab; Snapshots liegen im Runtime-Store.
- API-Routen werden dünne Store-Reader (gleiche Response-Shapes, damit
  Frontend/React Query erhalten bleiben).
- Deployment: Nautilus (Docker, GitHub-Actions-Build/-Deploy, Sealed
  Secrets, Egress-Allowlist). Netlify, Blobs-Cache, Warmer und
  next-auth-Login entfallen; Zugriffsschutz ist das VPN.
- `/health` als Liveness/Readiness-Probe mit Domain-Status.

## Entscheidungen (mit Benutzer abgestimmt, 2026-10-14)

- Nautilus ersetzt Netlify komplett.
- next-auth-Login wird entfernt (VPN wie Growth Cockpit; Authelia
  nachrüstbar).
- „Edge-Speicherung" = Runtime-Store wie Growth Cockpit (In-Memory +
  tmpdir-JSON im Pod).
- MCP-Server bleibt, liest aus dem Store statt Self-Fetch.
- Poll-Takte: HubSpot ~15 min, Projekte/JIRA ~60 min,
  Marketing-Funnel + Playbook (BigQuery) alle 6 h.
- Refresh-Button entfällt (Query-Rate nur aus dem Poll-Timer).

## Meilensteine

### M1 — Runtime-Layer ✅
- `src/lib/runtime/store.ts`: In-Memory + tmpdir-Persistenz
  (`SALES_COCKPIT_STORE_DIR`, Default `os.tmpdir()/sales-cockpit-store`),
  Status je Key für `/health`.
- `src/lib/runtime/poller.ts`: Boot-Poll + Timer je Domain; ohne
  Credentials bleibt der jeweilige Poll aus.
- `src/instrumentation.ts` + `src/lib/sources/proxy.ts` (undici
  EnvHttpProxyAgent für den Nautilus-Egress-Proxy).
- `src/app/health/route.ts`.

### M2 — Builder-Extraktion ✅
- `src/lib/overview/deals.ts`: `buildPipelineOverview` aus der Route
  extrahiert (inkl. Typen, PipelineNotFoundError).
- `src/lib/overview/deal-enrichment.ts`: Meetings- + Stage-History-Maps
  aus den beiden Sub-Routen extrahiert.
- `src/lib/overview/projects.ts`: `buildProjectsOverview` aus der Route
  extrahiert.

### M3 — BigQuery auf REST umstellen ✅
- `src/lib/amplitude/client.ts`: JWT-Flow + `jobs.query`-REST-API
  (Muster growth-cockpit `bq.ts`), Dry-Run-Kostencheck, Hard-Cap
  `maximumBytesBilled` 300 GiB, Pagination, Timeout-Race.
  Signatur von `runBigQueryQuery` bleibt — alle 13 Aufrufer unberührt.
  Grund: der @google-cloud/bigquery-SDK nutzt gRPC, das den
  Nautilus-Squid-Egress-Proxy (http_proxy) ignoriert.
- `@google-cloud/bigquery`-Dependency entfällt.

### M4 — Routen werden Store-Reader ✅
- deals/overview, meetings, stage-history, leads, projects, marketing
  funnel, playbook-stats, pipelines: lesen aus dem Store, 503
  `{warming:true}` bei Cold Store.
- Entfernen: `src/lib/server-cache.ts`, `src/lib/overview/warm-cache.ts`,
  `warm-targets.ts`, `netlify/`, `netlify.toml`, `?refresh=1`,
  localStorage-Cache `src/lib/pipeline-cache.ts`.
- Live bleiben (interaktive Ausnahmen, dokumentiert): `/api/deals/[dealId]`
  (Canvas-Editor, schreibt), `/api/jira/issue/*`, `/api/jira/epic/*`
  (einzelne Issue-Lookups).

### M5 — Auth-Entfernung ✅
- `middleware.ts`, `src/lib/auth/`, `src/app/login/`, `/api/auth`,
  next-auth-Dep, `useSession`/`isAuthenticated`-Gates in page.tsx + tv.
- TV_SECRET-Bypass entfällt überall (auch MCP-Self-Fetch weg).

### M6 — MCP auf Store ✅
- `src/lib/mcp/data.ts` liest direkt aus dem Runtime-Store
  (kein Self-Fetch, kein TV_SECRET). MCP_SECRET bleibt.

### M7 — Nautilus-Deploy ✅
- `Dockerfile` (standalone, Port 8080, non-root), `.sipgate/nautilus.yaml`
  (CRD, Egress: HubSpot/Atlassian/BigQuery/OAuth, Sealed Secrets via
  `nautilusctl`), `.github/workflows/nautilus-build.yaml` +
  `nautilus-deploy.yaml` + `nautilus-undeploy.yaml`.
- `@sipgate/revop-ui` auf gepinnte Registry-Version (npm.pkg.github.com),
  `.npmrc`, BuildKit-Secret `npm_token` (wie growth-cockpit).
- `package.json`: preinstall-Netlify-Script weg, undici dazu,
  @netlify/* und next-auth raus.

### M8 — Doku + Verifikation ✅
- AGENTS.md/README: Cache-/Warmer-/Netlify-Sektionen raus, Runtime-Poller
  + Nautilus-Deploy rein.
- Verifikation: `npm run build`, lint, Production-Start im Worktree,
  Endpunkt-Check gegen echten Store (mit .env.local aus dem Main-Checkout).

## Poll-Domains und Takte

| Domain (Store-Key) | Takt (Env) | Quelle |
|---|---|---|
| `pipelines` | 15 min (`POLL_HUBSPOT_MS`) | HubSpot |
| `dealsOverview:<pipelineId>:<produkt>` (alle 6 Portfolio-Werte) | 15 min | HubSpot (+ BQ-Attribution bei frontdesk) |
| `dealEnrichment:<pipelineId>:<produkt>` (meetings + stage history) | 15 min | HubSpot |
| `leadsOverview:<produkt>` (alle 6) | 15 min | HubSpot (+ BQ bei frontdesk) |
| `projectsOverview:frontdesk` | 60 min (`POLL_PROJECTS_MS`) | HubSpot + JIRA |
| `marketingFunnel:frontdesk:<days>` für days ∈ {30, 60, 90, 180, all} | 6 h (`POLL_BQ_MS`) | BigQuery + HubSpot |
| `playbookStats:<days>` für dieselben days | 6 h | BigQuery |

Boot-Poll beim Server-Start. `POLL_*_MS` übersteuert die Takte.

## Festlegungen

- Frontend bleibt Client-App mit React Query; die Routen behalten ihre
  Response-Shapes (`{success, data}`), nur `cache`-Metadaten werden durch
  `stand` (Snapshot-Zeit) ersetzt.
- Meetings/Stage-History werden je Portfolio-Snapshot für genau die
  Deal-IDs des Deals-Overview-Snapshots gepollt; die Routen liefern
  Teilmengen aus der Map.
- Marketing-Fenster: die drei UI-Presets (30/90/all) plus die
  Vergleichsfenster (60/180/all×2) werden gepollt, damit der KPI-Tree
  ohne Cold Path auskommt.
- localStorage-pipeline-cache entfällt (Store-Antworten sind schnell);
  React Query `retry` überbrückt Cold-Start-503 wie bisher.
- Kosten-Leitplanken bleiben: Batch-Endpunkte, Semaphore (4 concurrent)
  im HubSpot-Client, `maximumBytesBilled` 300 GiB + Dry-Run-Check je
  BigQuery-Query; Query-Rate nur aus Poll-Timern.
- Sanity-Checks: je Domain leichte Strukturprüfungen (Pflichtfelder,
  endliche Zahlen, nicht-negative Zähler); Verletzung = Rollback +
  Fehlerstatus in `/health`.

## Arbeitsregeln

- Branch `feat/nautilus-runtime`, Worktree `../sales-cockpit-nautilus`,
  geschnitten von `origin/main`.
- Merge via PR ins repo-eigene Tracker-Repo; Referenz `Closes #NN`, wenn
  ein Issue existiert.
- Push immer als expliziter Schritt, nie auto.
