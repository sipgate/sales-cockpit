# Agent Instructions

## sipgate product model — suite with multiple entry points

sipgate is a **product suite**, not a single product. Customers can enter
through different products (PBX, AI Agents / Frontdesk, etc.) and then
add more products to their account.

Key distinction for analytics: **Signup ≠ Trial/Preview.**

- **Signup** (`Signup Atlantis` in Amplitude) = creating a sipgate account,
  with a `product` property indicating the entry point (`FRONTDESK`,
  `PBX`, etc.).
- **Trial / Preview** = activating a time-limited test of a specific
  product (e.g. AI Agents). This is a separate step that can happen
  *after* any signup type — a PBX customer can start an AI Agent preview
  just as well as someone who signed up directly for Agents.

This means `Signup Atlantis` with `product='FRONTDESK'` does **not**
equal "AI Agent Preview started". The preview/trial activation is tracked
elsewhere (PBX provisioning system), not as an Amplitude event. When
comparing funnel data, do not conflate the two.

## Branching, Commits & Session Isolation

"I thought the feature was live, but it never shipped" has two root causes that
pull in opposite directions — so guarding against only one reintroduces the other:

- **Branch rot:** work committed to a branch that was never merged.
- **Working-tree rot:** work never committed at all — concurrent sessions piling
  uncommitted changes into the *same* working directory until they entangle and
  none of it ships.

Feature branches *are* branch rot and don't fix working-tree rot, so
"branch vs main" is the wrong axis. The rules below attack both roots directly:
**session isolation**, a **hard done-gate**, and disciplined integration.

**Base invariant — local `main` mirrors `origin/main` at all times.** Every
divergence disaster starts here: the shared checkout accumulates commits that
never reach `origin` (or the same work lands on `origin` via a squash-merge under
a *different* SHA), so the two histories split while looking identical, and Git
then reports conflicts where there is no real content difference. Prevent it —
don't reconcile it after the fact:

- **Start clean.** Before any change-session — and before spawning a worktree —
  run `git fetch origin && git switch main && git merge --ff-only origin/main`.
  If the fast-forward is refused, local `main` has already drifted: stop and
  reconcile it *first* (rebase/merge the unique local commits onto `origin/main`,
  or discard them), never build on top of the drift.
- **Cut worktrees from `origin/main`, never from local `HEAD`.** A worktree
  branched off a stale checkout inherits the drift and yields a PR whose base is
  wrong — the noisy-diff / phantom-conflict trap.
- **Never leave commits sitting on local `main` unpushed.** Push is a separate,
  explicit step (never auto-coupled to the commit), but it must not be *deferred*:
  push before you end the session, before you cut a worktree, and before you step
  away. Unpushed local-`main` commits are the seed of every "same feature, two
  SHAs" conflict, especially once the same work also arrives through a PR.
- **Re-sync the serving checkout after every merge.** The dev server runs from the
  main checkout; merging a PR on GitHub does **not** update it. After a merge, in
  the main checkout run `git fetch origin && git merge --ff-only origin/main`
  (restart the dev server if it caches build output). Skip this and the live
  preview keeps showing stale code — the exact "I don't see my change" trap.

### 1. Isolate every change-session in its own git worktree

Any session that will modify code works in its **own git worktree**, never in the
shared main checkout. Two concurrent sessions then cannot entangle each other's
working tree. (Claude Code: use `isolation: "worktree"`.) The worktree is
disposable; what matters is that its changes reach `main` via the done-gate below
before the session ends.

**Clean up the worktree when you're done.** Once its changes have reached `main`,
remove it — `git worktree remove <path>`, and `git worktree prune` for any that
were deleted by hand. Never leave abandoned worktrees behind: they accumulate in
`git worktree list`, hold stale copies that mislead the next session, and
detached-HEAD leftovers are pure clutter. Claude Code's `isolation: "worktree"`
auto-removes a worktree that ends unchanged, but any worktree you committed work
in must be cleaned up explicitly.

**Live-preview caveat:** the Next.js dev server runs from the main checkout and
does **not** see edits made in a worktree — this used to bite repeatedly (agent
edits in a worktree, user stares at stale UI). When a task needs live visual
verification, either run the dev server from the worktree for the session, or merge
to `main` and verify there. Never assume the running app reflects worktree edits.

### 2. Done = committed + pushed + deploy-verified

A change is not "done" until it is committed, pushed to `main`, and the
resulting nautilus build workflow (GitHub Actions, `.github/workflows/nautilus-build.yaml`)
is confirmed green — it builds the Docker image the cluster deploys. **Never end a session with uncommitted or
unpushed changes that belong to the task.** Committing and pushing are separate
steps: commit as you go, but **push is always an explicit step** — never auto-push
on commit, never bundle "commit + push" into one action (global rule: never
`git push` without asking). At session end, `git status` must be
clean except for deliberately-ignored artifacts. If work is genuinely unfinished,
say so explicitly and leave it committed on a clearly-named branch — not loose in a
working tree.

### 3. Choose the integration path at the first change of a session

- **Direct to `main`** — for small, low-risk changes. Small commits, often;
  the push follows as a separate explicit step.
- **Worktree + branch + GitHub issue + PR** — for larger or riskier features where
  a review/merge checkpoint and traceability are worth it. An opened PR must be
  merged or closed within the session — never left to rot.

Either way, the done-gate (rule 2) applies. If a change is too risky for `main`,
gate it with a feature flag, not a long-lived branch. Issues and PRs live in this
repo's own tracker (<https://github.com/sipgate/sales-cockpit>); reference the
issue from the closing commit with `Closes #NN`.

### 4. Guard against foreign in-flight work

At the start of a change-session, check `git status`. If it already contains
uncommitted changes you did not create, another session owns them — do not build on
top of or commit them blindly. Surface them and either work in a fresh worktree off
`origin/main` (per the base invariant — never off a possibly-stale local `HEAD`)
or coordinate before touching shared files.

## HubSpot authentication — Private App Token in sipgate 2025 (27058496)

**TL;DR:** The app authenticates against HubSpot with a **Private App Token**
stored in `HUBSPOT_PRIVATE_APP_TOKEN` (`.env.local`). No OAuth, no refresh
flow, no Connected App install. The token is created by a HubSpot admin
(Phil) inside the sipgate 2025 HubSpot portal. That's it — everything below
is history, reasoning, and procedures so the next agent doesn't repeat the
painful path we took to get here.

### The two sipgate HubSpot accounts (do not confuse)

| Hub ID | Name | Role |
|---|---|---|
| `2610461` | sipgate GmbH | **HubSpot Developer portal** (legacy CRM data too, but not where our deals live). This is where the old `sales-canvas-auth` / `sales-canvas-clean` Projects apps are defined. |
| `27058496` | sipgate 2025 | **The real CRM.** The pipeline `3576006860` ("Sales sipgate Portfolio") and all current deals (e.g. `495181833409` "2.500 P24 - Anton Herzog") live here. This is the account the Private App Token is issued from. |

If you query HubSpot with the token and don't see the expected deal/pipeline,
you're almost certainly pointing at the wrong hub. Verify by calling
`/oauth/v1/access-tokens/{token}` (for OAuth tokens) or by reading a known
deal ID directly.

### The token

- **Env var:** `HUBSPOT_PRIVATE_APP_TOKEN`
- **Format:** `pat-eu1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- **Expiry:** None. Private App Tokens do not expire unless revoked.
- **Issued by:** a HubSpot admin in hub `27058496`. In practice: **Phil** at
  sipgate. `mellor@sipgate.de` does *not* have the "Private Apps" permission
  in that hub and cannot create or rotate the token himself.
- **Read path in code:** `src/lib/hubspot/client.ts` → `getAccessToken()`.
  There is no caching, no refresh, no retry on 401. Just send the token.

### Required scopes on the Private App

All of these must be checked when the token is created. Missing any of them
silently breaks parts of the pipeline view (see "fail-safe" note below).

- `crm.objects.deals.read`
- `crm.objects.deals.write`
- `crm.objects.contacts.read`
- `crm.objects.companies.read`
- `crm.objects.owners.read`
- `crm.objects.line_items.read`   *(needed for line-item batch read)*
- `crm.schemas.deals.read`
- `e-commerce`                    *(also needed for line-item batch read —
  `crm.objects.line_items.read` alone is not enough)*

### Ready-to-send message template for Phil

> Hey Phil, können wir für das Sales Cockpit einen Private App Token in unserem HubSpot (Account 27058496, "sipgate 2025") einrichten?
>
> Was ich brauche:
>
> 1. Settings → Integrations → **Private Apps** → *Create a private app*
> 2. Name: z.B. "Sales Cockpit"
> 3. Unter **Scopes** diese 8 aktivieren:
>    - `crm.objects.deals.read`
>    - `crm.objects.deals.write`
>    - `crm.objects.contacts.read`
>    - `crm.objects.companies.read`
>    - `crm.objects.owners.read`
>    - `crm.objects.line_items.read`
>    - `crm.schemas.deals.read`
>    - `e-commerce`
> 4. Create → den Access Token kopieren (beginnt mit `pat-eu1-…`)
>
> Schick mir den Token dann bitte verschlüsselt (z.B. per 1Password, signierte Nachricht o.ä.) zu. Ich trag ihn lokal in `.env.local` ein.

### Things that do NOT work — do not try them

These are dead ends we already walked. Do not suggest them to the user again.

1. **"Go to Settings → Private Apps in sipgate 2025 HubSpot and create a token yourself."**
   The user (`mellor@sipgate.de`) lacks the following permissions in hub
   `27058496`: *App Marketplace access*, *Products → Delete*, *Edit property
   settings*. The Private Apps screen refuses with "You don't have permission
   to access private apps". Only admins (Phil) can do this.

2. **"Install the HubSpot Projects app in the sipgate 2025 account."**
   The existing Connected App `sales-canvas-auth-Application` (App ID
   `29591037`, defined in the developer portal `2610461`, distribution
   `marketplace`) used to be reachable via the install URL
   `/connected-apps/27058496/installed/basic/29950502/overview` but blocks
   new installs with *"The app could not be installed because the app
   developer has not signed the acceptable use policy"* until the AUP is
   signed via the "Begin publishing your HubSpot app" wizard.

3. **"Change the app's distribution from `marketplace` to `private`."**
   HubSpot rejects this upload: *"You cannot change the app's distribution
   type from 'marketplace' to 'private'."* The distribution is immutable
   after the first deploy.

4. **"Create a new `distribution: private` HubSpot Projects app and install
   that in 27058496 instead."**
   Private-distribution apps cannot be installed in a production account
   they don't belong to — the target account appears grayed out with
   *"Dieser Account kommt nicht für die Installation in Frage"*. There was
   a short-lived `sales-cockpit-internal` project that tried this and was
   abandoned; its directory has been removed from the repo. If you see it
   reappear in a git history, know that it is a dead branch of the problem.

5. **Using OAuth refresh tokens (`HUBSPOT_REFRESH_TOKEN` + `HUBSPOT_CLIENT_ID`
   + `HUBSPOT_CLIENT_SECRET`).**
   The code used to support this but it's now removed. If the three env
   vars are present in someone's `.env.local` from an earlier setup, they
   are just noise — the client reads `HUBSPOT_PRIVATE_APP_TOKEN` only.
   Remove them to avoid confusion.

### The `sales-canvas-clean` project directory

`hubspot-app/sales-canvas-clean/` is still in the repo but is **dormant**.
It defines the old `sales-canvas-auth-Application` (App ID `29591037`,
marketplace distribution, AUP-signed, installed in `27058496`). We no
longer authenticate through it. Keep it around as reference — do not
delete without a cleanup commit and a note that the OAuth path is gone.

### Line-item scope — the specific failure mode we hit repeatedly

The AI Agent pipeline filters deals by line-item `category`. If the token
is missing either `crm.objects.line_items.read` or `e-commerce`:

- `getDealsWithAssociations` returns all deals (no problem).
- `/crm/v3/objects/line_items/batch/read` throws 403
  *"This app hasn't been granted all required scopes"*.
- Deals that have line items get silently dropped from the AI Agent view
  because the category filter returns empty strings.

`getLineItemCategoriesForDeals` is written fail-safe: when the batch read
fails, it *skips* affected deals from the returned map so the caller's
`!categories` branch treats them as "keep, unknown category" rather than
"drop". **Fix the scope — don't paper over this in code.**

### Rate limits

HubSpot enforces a per-second (~10 req/s) and a 10-secondly (~100 req/10s)
limit per Private App. On page load, `/api/deals/overview`,
`/api/leads/overview` and `/api/projects/overview` fire in parallel and each
fans out 4–8 batch reads, which used to blow past the secondly limit and
break the whole UI with 500s ("You have reached your secondly limit.").

`src/lib/hubspot/client.ts` now handles this at the transport layer:

- **Module-level semaphore** caps in-flight HubSpot requests at
  `MAX_CONCURRENT_HUBSPOT_REQUESTS = 4`. One Node process = one bucket,
  so this implicitly throttles all three overview endpoints together.
- **429 retry** in `HubSpotClient.request`: up to `MAX_429_RETRIES = 5`,
  honouring the `Retry-After` header (clamped to 10 s) with small jitter.
  The semaphore slot is held during the backoff so the queue
  back-pressures instead of stampeding on retry.

Do not paper over residual 429s in callers — fix the limits here. If
HubSpot pressure changes, tune the constants at the top of `client.ts`.

### Never fan out per deal — always batch

Rule: **any endpoint that processes a list of deals must use HubSpot's
batch endpoints, not a loop of per-deal calls**. HubSpot offers
`/crm/v4/associations/{from}/{to}/batch/read` for associations and
`/crm/v3/objects/{type}/batch/read` for object details — both take up to
100 inputs per call. A 150-deal pipeline should cost 2–4 HubSpot calls,
never 300.

Why this matters: per-deal fan-out at `BATCH_SIZE=4` with a 300 ms pause
is ~28 req/s — 3× the 10 req/s limit. Rate-limited calls return 429 and
get `try/catch`'d to `null`, indistinguishable from "no result". That
null then lands in the `pipeline-cache-*` localStorage entry and sticks
around — refresh doesn't help because the next fetch hits the same
ceiling. This bit us on the meetings endpoint (deal 497714974930 "Taxi
Höhne" showing no next appointment despite having one). Fix:
`HubSpotClient.getMeetingsForDeals(dealIds)` — 2 batch calls total,
independent of pipeline size.

Checklist when writing a new endpoint that touches N deals:

1. Is there a `/batch/read` endpoint for what you need? Use it.
2. Do not swallow API errors into `null`. At minimum log + rethrow so the
   request fails loudly; the client can retry the whole query.
3. Never persist an error-derived `null` into the localStorage cache.
   Only cache responses from successful, complete fetches.

### Lead ↔ Deal association is one-directional

HubSpot in `27058496` only stores the association in the `leads → deals`
direction (typically with type `Primary`, typeId 582). The reverse call
`/crm/v4/associations/deals/leads/batch/read` returns
`NO_ASSOCIATIONS_FOUND` for every deal — even ones that clearly came
from a lead. Endpoints that need to join a deal to its originating lead
must fetch `leads → deals` for the lead set and invert the map locally;
see `getLeadsWithAssociations` and `LeadOverviewItem.associatedDealIds`.

## Runtime-Store & Hintergrund-Poller (Nautilus-Architektur)

Das Cockpit läuft als **Nautilus-Service** im sipgate-Tooling-Cluster
(`nautilus-tooling01`, Muster: growth-cockpit / sona-monitor). Kein Netlify
mehr. Datenfluss:

- **Ein Hintergrund-Poller** (`src/lib/runtime/poller.ts`, gestartet über
  `src/instrumentation.ts` beim Server-Start) holt alle Messdaten von den
  Quellen (HubSpot, JIRA, Amplitude BigQuery) **auf Timern** in einen
  **Runtime-Store** (`src/lib/runtime/store.ts`: In-Memory, persistiert als
  JSON unter `SALES_COCKPIT_STORE_DIR`, Default `os.tmpdir()/sales-cockpit-store`,
  damit ein Reboot nicht mit leerem Store startet).
- **Alle Read-Endpoints** (`/api/deals/overview`, `/meetings`, `/stage-history`,
  `/api/leads/overview`, `/api/projects/overview`, `/api/marketing/funnel`,
  `/api/amplitude/playbook-stats`, `/api/pipelines`) sind dünne Store-Reader:
  sie leiten nur noch weiter, was der Poller gelegt hat. Kein Quellen-Fetch
  auf dem Request-Pfad. Antwortet der Store kalt: `503 { warming: true }`
  (Boot-Poll läuft, Client retryt über React-Query).
- **Query-Rate gegen die Quellen kommt ausschließlich aus den Poll-Timern**,
  nie aus Requests. Frische Daten = nächster Poll-Tick, nicht der
  Refresh-Button (der invalidiert nur die React-Query-Caches).
- **Live-Ausnahmen** (schreiben oder interaktiv, kein Poll-Takt):
  `/api/deals/[dealId]` (Canvas GET/PATCH) und `/api/jira/*` lesen direkt
  von HubSpot bzw. JIRA.
- **Auth: keine.** Der Service steht im Tooling-Cluster hinter VPN.
  next-auth, Login-Route, Middleware und TV_SECRET-Bypass sind entfernt;
  der MCP-Endpoint behält seinen Bearer (MCP_SECRET).

### Poll-Takte und Domänen

| Domäne (Store) | Varianten | Takt (Env) |
|---|---|---|
| `pipelines` | – | 15 min (`POLL_HUBSPOT_MS`) |
| `dealsOverview` | `SALES_PIPELINE_ID` × 6 Portfolio-Werte | 15 min (`POLL_HUBSPOT_MS`) |
| `dealEnrichment` (Meetings + Stage-History) | je dealsOverview-Variante | 15 min (im selben Poll) |
| `leadsOverview` | je Portfolio-Wert | 15 min (`POLL_HUBSPOT_MS`) |
| `projectsOverview` | `frontdesk` (HubSpot + JIRA) | 60 min (`POLL_PROJECTS_MS`) |
| `marketingFunnel` | `frontdesk` × Day-Windows 30/60/90/180/all | 6 h (`POLL_BQ_MS`) |
| `playbookStats` | Day-Windows 30/60/90/180/all | 6 h (`POLL_BQ_MS`) |

Day-Windows: die drei UI-Presets (30/90/all) plus die aktiven
Vergleichsfenster (×2), damit der KPI-Tree ohne Cold Path rechnet. `all`
wächst täglich und wird je Lauf neu berechnet (bekannter Wrinkle: der
Store sammelt pro Tag einen neuen `:all`-Key).

### Sanity-Checks und Status

Jeder Poll-Lauf prüft den Snapshot auf Plausibilität (nicht-leere Stages,
Zahlen ≥ 0, …), bevor er ihn übernimmt; bei Verletzung bleibt der letzte
gültige Stand stehen und der Fehler landet im Status. `GET /health`
liefert je Variante `stand` (letzter erfolgreicher Poll), `lastAttemptAt`
und `error` — Liveness/Readiness-Probe des Clusters, Datenqualität liest
man aus dem `error`-Feld, nicht aus dem Statuscode.

### BigQuery: REST statt SDK (Proxy!)

`src/lib/amplitude/client.ts` nutzt die **BigQuery-REST-Jobs-API mit
Service-Account-JWT** (`GOOGLE_APPLICATION_CREDENTIALS_JSON` inline oder
`GOOGLE_APPLICATION_CREDENTIALS` als Pfad), NICHT das
`@google-cloud/bigquery`-SDK: Das SDK spricht gRPC, gRPC ignoriert die
`http_proxy`-Env-Variablen, die Nautilus den Pods injiziert — jede Query
würde still am Egress-Proxy scheitern. fetch (undici) geht sauber durch
den Proxy (globaler `EnvHttpProxyAgent` aus `src/lib/sources/proxy.ts`).

Kosten-Leitplanken (unverändert): Dry-Run je Query mit
`maximumBytesBilled` (Default 300 GiB, `BIGQUERY_MAX_BYTES_BILLED`), und
die Frequenz nur aus den Poll-Timern. Siehe "Cost guardrails" in
`src/lib/amplitude/client.ts`.

### Deploy

- `Dockerfile` — Standalone-Build (`NEXT_PRIVATE_STANDALONE=true`), Port
  8080, non-root, BuildKit-Secret `npm_token` für `@sipgate/revop-ui` aus
  `npm.pkg.github.com` (Repo braucht Actions-Zugriff auf das Package).
- `.sipgate/nautilus.yaml` — CRD: Egress zu `api.hubspot.com`,
  `sipgatede.atlassian.net`, `bigquery.googleapis.com`,
  `oauth2.googleapis.com`; `replicasPerLocation: 1` (Poller-Store, doppelte
  Replikas würden doppelt pollen). **Secrets müssen vor dem ersten Deploy
  mit `nautilusctl` versiegelt werden** (Platzhalter `TODO_SEAL` im YAML);
  zu versiegeln: `HUBSPOT_PRIVATE_APP_TOKEN`, `JIRA_API_TOKEN`,
  `JIRA_BASE_URL`, `JIRA_EMAIL`, `MCP_SECRET`,
  `GOOGLE_APPLICATION_CREDENTIALS_JSON`.
- `.github/workflows/nautilus-{build,deploy,undeploy}.yaml` — Build auf
  push/PR, Deploy via repository_dispatch (dev → live), Muster
  growth-cockpit.

## JIRA authentication — sipgate Atlassian Cloud (sipgatede.atlassian.net)

**TL;DR:** The app reads JIRA via a personal **Atlassian Cloud API token**,
sent as HTTP Basic Auth (`email:token`, base64). Three env vars in
`.env.local`:

```
JIRA_BASE_URL=https://sipgatede.atlassian.net
JIRA_EMAIL=<the sipgate mail you log into JIRA with>
JIRA_API_TOKEN=<the token from id.atlassian.com>
```

Read-only — Phase 1 does not write to JIRA.

### Where the token comes from

Create at https://id.atlassian.com/manage-profile/security/api-tokens.
**Use the left button "Create API token"**, NOT the right one ("Create API
token with scopes"). The scoped variant is OAuth-2.0-flavored and would
require a different auth mechanism (Bearer against
`api.atlassian.com/ex/jira/{cloudId}/...` instead of Basic against the
tenant URL). Both token types share the `ATATT3xFf…=CHECKSUM` shape, so
you cannot tell them apart from the value alone — only by which button
was clicked. If `/rest/api/3/myself` returns 401 with "Client must be
authenticated" despite a freshly minted token, you almost certainly used
the wrong button. Revoke and recreate.

### Where JIRA is linked to a deal

HubSpot deal property: **`jira_story`** (label "Jira Story", description
"CS Agents (Nils)"). Single-line URL field. The URL format varies — we
have seen all of:

- `https://sipgatede.atlassian.net/browse/PDH-322`
- `https://sipgatede.atlassian.net/browse/SC-12?atlOrigin=…`
- `https://sipgatede.atlassian.net/jira/core/projects/SC/board?selectedIssue=SC-4`

Project keys are not constrained to one project (`SC`, `PDH`, …). Use
`extractJiraIssueKey()` from `src/lib/jira/parse.ts` — it handles all
three shapes plus bare keys.

The HubSpot field is also misnamed: despite "story", it can point at any
issue type. SC-167 for example is a Developer Task, not an Epic. Code
that consumes it must not assume hierarchy — `getEpicChildren` simply
returns an empty array when the issue has no children, which is the
correct read for a non-epic issue.

### What the client offers (`src/lib/jira/client.ts`)

- `getIssue(key)` — single issue projected onto a minimal `JiraIssue`
  shape (summary, status, assignee, story points, parent, timestamps).
- `getEpicChildren(key)` — JQL `parent = "<key>"` paginated via the new
  `/rest/api/3/search/jql` POST endpoint. Returns an array.
- `getEpicWithChildren(key)` — convenience wrapper that fans both calls
  out in parallel.
- `getIssuesByKeys(keys)` — JQL `key in (...)` batch, chunked at 100.
- `getChildrenForParents(keys)` — JQL `parent in (...)` batch, returns a
  `Map<parentKey, JiraIssue[]>`.

### Sub-Task hierarchy: parent-field vs. issue-links

In the sipgate SC project, child issues are almost always linked to their
parent via a JIRA **issue-link of type "Parent"** (inward "is a parent of"),
not via the `parent` field. Concrete example: SC-53 (DER SPIEGEL) has
SC-60 and SC-61 as children — both linked exclusively via issue-links,
their `parent` field is empty.

That means `getChildrenForParents()` alone is not enough — it only finds
parent-field children. The full picture requires also reading `issuelinks`
from the parent issue (now part of `ISSUE_FIELDS`) and extracting all
inward "is a parent of" links. `JiraIssue.linkedChildKeys` carries those
keys. The `/api/projects/overview` route merges both sources to compute
the sub-task dot counts.

Filter on `type.name === 'Parent'` OR `type.inward` containing "parent of"
(robust against German localisation). Other link types ("blocks",
"relates to", …) must NOT be treated as parent-child.

We use the **new** `/rest/api/3/search/jql` endpoint, not the deprecated
`GET /rest/api/3/search`. Pagination is via `nextPageToken`, with a
50-iteration safety cap (5000 child issues per epic).

### Story points custom field

JIRA story-point custom field IDs vary per portal. The client probes
`customfield_10016` → `customfield_10026` → `customfield_10004` in
order and uses the first one that has a numeric value. sipgate's portal
uses `customfield_10016` at the time of writing.

### API routes

- `GET /api/jira/issue/<KEY>` — `JiraIssue`.
- `GET /api/jira/epic/<KEY>` — `{ epic: JiraIssue, children: JiraIssue[] }`.
- `GET /api/projects/overview?produkt=frontdesk` — feeds the **Projekte**
  tab in the UI. Walks all frontdesk-deals with `jira_story`, resolves
  each to a JIRA issue, plus children (via parent-field AND issue-links).

  Each `ProjectOverviewItem` carries a `dateSource`:
  - `jira-test-phase` — JIRA `customfield_11758` ("Ende der Testphase")
    is set; bar runs `end - 27d` to `end`.
  - `deal-won-fallback` — JIRA date is missing but the HubSpot deal is
    won; bar runs from `closedate` to `closedate + 27d`. Rendered hatched
    in the UI to signal the missing JIRA data.

  Deals where neither anchor is available end up in `unscheduledCount`.

The first two routes validate the key with `isJiraIssueKey()` and return
400 on garbage, 404 if JIRA returns 404, 502 on other JIRA errors.

## Local dev URL — DO NOT use the Caddy HTTPS URL

The local dev server runs on **`http://localhost:3020`**. Never navigate to
`https://sales-cockpit.localhost` (the Caddy reverse-proxy URL) from
browser automation tools (Claude in Chrome, preview tools, etc.). The
Caddy URL triggers certificate warnings, auth redirects, and other issues
that break automated testing. Always use `http://localhost:3020` directly.

## MCP server — `/api/mcp` (Streamable HTTP)

The cockpit exposes its consolidated numbers to AI agents through an MCP
server, served in-app as a Next.js route at **`/api/mcp`** (Streamable
HTTP transport, via `mcp-handler` + `@modelcontextprotocol/sdk`). It is
optimised for the **AI Agents (`frontdesk`)** product — every tool defaults
to that portfolio.

### Why in-app, not standalone

The tools do **not** re-derive anything. `src/lib/mcp/data.ts` reads the
same runtime-store snapshots the API routes serve — byte-identical
numbers, no HTTP self-fetch, no internal auth. A cold store raises a
tool error ("Store ist für diese Variante noch kalt").

### Tools

| Tool | What it returns |
|---|---|
| `get_kpi_tree` | The full KPI tree as structured data (flat node list: id, label, current value/target, team, parents, formula). Params: `days` (default 30), `goalSet` (`q2-2026`\|`q3-2026`, default `q2-2026`), `deOnly` (default true). |
| `get_consolidated_metrics` | Everything behind the charts in one call: pipeline KPIs + marketing funnel + playbook + projects. Params: `days`, `deOnly`, `minMrr`. |
| `get_pipeline_summary` | HubSpot pipeline KPIs (won/lost/open, MRR/ARR, win rate, sales cycle, per-stage + per-ICP-tier). Params: `produkt`, `deOnly`, `minMrr`. |
| `get_marketing_funnel` | Five funnel stages + BigQuery signup/preview totals. Param: `days`. |
| `get_playbook_stats` | Preview → 3+ playbooks adoption. Param: `days`. |
| `get_projects_summary` | Onboarding/implementation project status counts. Param: `produkt`. |

### Single source of truth for the KPI tree

The KPI-tree model + math is shared, not duplicated. `KpiTreeView.tsx` and
the MCP server both import from `src/lib/kpi-tree/`:

- `model.ts` — `METRICS`, `GOAL_SETS`, formatting helpers.
- `compute.ts` — `computeLiveValues()` (per-week values) and
  `resolveKpiTree()` (computed nodes like MRR = Sales × ARPA, and the
  cascading derived targets). The React view's `resolved` memo is just a
  call to `resolveKpiTree()`.
- `build.ts` — `buildKpiTree()`, the structured-tree assembler for MCP.

So the numbers an agent reads are byte-for-byte the ones the tree renders.
If you change the tree's math, change it in `src/lib/kpi-tree/` — never
fork it back into the component.

### Auth + client config

The endpoint requires a static bearer token in **`MCP_SECRET`** (returns
`503` if unset, `401` on a bad token). Send it as
`Authorization: Bearer <MCP_SECRET>` (query fallback: `?mcpSecret=`).

`.mcp.json` (committed) wires Claude Code to `http://localhost:3020/api/mcp`
with `Authorization: Bearer ${MCP_SECRET}`. The `${MCP_SECRET}` is expanded
from **Claude Code's own environment**, so export it in the shell you launch
Claude Code from (the value lives in `.env.local`; it is never committed).
The dev server picks up `MCP_SECRET` from `.env.local` automatically.
