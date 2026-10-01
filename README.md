# Sales Cockpit

Verkaufs-Cockpit für sipgate: Pipeline-Übersicht (HubSpot), Leads, Projekte
(HubSpot + JIRA), Marketing-Funnel und KPI-Tree (Amplitude via BigQuery) —
als **Nautilus-Service** im sipgate-Tooling-Cluster.

## Architektur

- **Runtime-Store + Hintergrund-Poller** (Muster: growth-cockpit): Ein
  Poller holt alle Messdaten auf Timern von HubSpot/JIRA/BigQuery in einen
  In-Memory-Store (JSON-Persistenz im tmpdir). Die API-Routen sind dünne
  Store-Reader — kein Quellen-Fetch auf dem Request-Pfad. Details:
  `AGENTS.md` → „Runtime-Store & Hintergrund-Poller".
- **Kein Login**: der Service steht hinter dem sipgate-VPN.
- **Live-Ausnahmen**: `/api/deals/[dealId]` (Canvas, inkl. PATCH) und
  `/api/jira/*` lesen direkt von den Quellen.
- **MCP-Server** unter `/api/mcp` (Streamable HTTP, Bearer `MCP_SECRET`)
  liest dieselben Store-Snapshots.

## Local dev

```bash
npm run dev
```

Open [http://localhost:3020](http://localhost:3020) — nicht die
Caddy-HTTPS-URL (`https://cockpit.localhost`), die sorgt für
Zertifikats-Warnungen und Redirects in Test-Tools.

Credentials in `.env.local` (Vorlage: `.env.example`):
`HUBSPOT_PRIVATE_APP_TOKEN`, `JIRA_*`,
`GOOGLE_APPLICATION_CREDENTIALS_JSON` (oder `-PATH`), `MCP_SECRET`.
Ohne Credentials startet der Server, aber die entsprechenden Polls
bleiben aus (Routen antworten 503, bis der Store gefüllt ist; siehe
`GET /health` für den Poll-Status).

Der erste Start nach einem Cold Store braucht einige Minuten, bis der
Boot-Poll alle Domänen gefüllt hat (Leads und Funnel sind die schwersten).

## Ports

Belegt im 3020er-Block (siehe [`~/Development/PORTS.md`](../PORTS.md)).

| Port | Service                            |
| ---- | ---------------------------------- |
| 3020 | Next.js dev server (Sales Cockpit) |

## Deploy (Nautilus)

- `Dockerfile` — Standalone-Next-Build, Port 8080, non-root.
- `.github/workflows/nautilus-build.yaml` baut bei push/PR das Image
  (BuildKit-Secret `npm_token` für `@sipgate/revop-ui` aus
  `npm.pkg.github.com`) und triggert nach `main`-Merges den Deploy.
- `.sipgate/nautilus.yaml` — Service-CRD mit Egress-Policies und
  versiegelten Secrets (nur dev, siehe `AGENTS.md`; Rotation per
  `nautilusctl set secret <KEY> -c nautilus-tooling01 -e dev -f <datei>`).

Alles Weitere (HubSpot-Token, JIRA-Token, Batch-Regeln, Kosten-Leitplanken
für BigQuery) steht im [`AGENTS.md`](AGENTS.md).
