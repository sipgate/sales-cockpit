// Hintergrund-Poller des Cockpits (Muster: growth-cockpit
// src/lib/runtime/poller.ts): holt alle Messdaten zur Laufzeit in den
// Runtime-Store, statt sie aus View-Requests heraus von den Quellen zu
// lesen. startPoller() läuft über src/instrumentation.ts beim Server-Start,
// pollt sofort einmal (Boot-Poll) und danach je Quelle im Timer-Takt:
//
//   HubSpot (pipelines, deals + enrichment + leads je Portfolio-Wert)
//                              alle 15 Minuten   (POLL_HUBSPOT_MS)
//   Projekte (HubSpot + JIRA)  alle 60 Minuten   (POLL_PROJECTS_MS)
//   Marketing-Funnel + Playbook (Amplitude BigQuery + HubSpot)
//                              alle 6 Stunden    (POLL_BQ_MS)
//
// Abfragefrequenz kommt nur aus den Timern, nie aus Requests. Kosten-
// Leitplanken: Batch-Endpunkte + Semaphore im HubSpot-Client,
// Dry-Run-Check + maximumBytesBilled je BigQuery-Query (client.ts). Jeder
// Snapshot wird vor dem Übernehmen auf Plausibilität geprüft (sanity);
// bei Verletzung bleibt der letzte gültige Stand stehen und der Fehler
// wird im Domain-Status für /health sichtbar.

import {
  AI_AGENTS_PRODUKT,
  PORTFOLIO_OPTIONS,
  SALES_PIPELINE_ID,
} from '@/lib/constants';
import { serviceAccountKey } from '@/lib/amplitude/client';
import { buildPipelineOverview } from '@/lib/overview/deals';
import { buildDealEnrichment } from '@/lib/overview/deal-enrichment';
import { buildLeadsOverview } from '@/lib/overview/leads';
import { buildProjectsOverview } from '@/lib/overview/projects';
import { buildMarketingFunnel } from '@/lib/overview/marketing-funnel';
import { getPlaybookStats } from '@/lib/amplitude/playbook-stats';
import { getHubSpotClient } from '@/lib/hubspot/client';
import { getDaysForPreset, canShowComparison, type DatePresetKey } from '@/lib/marketing/date-presets';
import type { PipelineOverviewResponse } from '@/lib/overview/deals';
import type { DealEnrichment } from '@/lib/overview/deal-enrichment';
import type { LeadsOverviewResponse } from '@/lib/overview/leads';
import type { ProjectsOverviewResponse } from '@/lib/overview/projects';
import type { MarketingFunnelResponse } from '@/lib/marketing/funnel-types';
import type { PlaybookStats } from '@/lib/amplitude/playbook-stats';
import {
  dealsKey,
  enrichmentKey,
  funnelKey,
  getStatuses,
  leadsKey,
  pipelinesKey,
  playbookKey,
  projectsKey,
  setSnapshot,
  setStatus,
  restoreSnapshot,
  clearSnapshot,
  getSnapshot,
  type SnapshotAddress,
} from './store';

const POLL_HUBSPOT_MS = Number(process.env.POLL_HUBSPOT_MS ?? 15 * 60_000);
const POLL_PROJECTS_MS = Number(process.env.POLL_PROJECTS_MS ?? 60 * 60_000);
const POLL_BQ_MS = Number(process.env.POLL_BQ_MS ?? 6 * 60 * 60_000);

/** Übernimmt einen Snapshot nur, wenn die Invarianten halten; sonst
 *  bleibt der bisherige Stand (Rollback) und der Fehler fliegt hoch. */
function commit<T>(
  address: SnapshotAddress,
  snapshot: T,
  check: (snapshot: T) => void,
): void {
  const previous = getSnapshot<T>(address);
  setSnapshot(address, snapshot);
  try {
    check(snapshot);
  } catch (error) {
    if (previous != null) restoreSnapshot(address, previous);
    else clearSnapshot(address);
    throw error;
  }
}

/** Serialisiert einen Fehler inklusive cause-Kette (undici meldert
 *  Netzwerkursachen wie DNS- oder Verbindungsfehler nur in `cause`). */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** Ein Poll-Lauf je Snapshot-Adresse: Versuch protokollieren, Fehler in
 *  den Status. */
async function runPoll(
  address: SnapshotAddress,
  poll: () => Promise<void>,
): Promise<void> {
  setStatus(address, { lastAttemptAt: new Date().toISOString() });
  try {
    await poll();
  } catch (error) {
    const message = errorText(error);
    setStatus(address, { error: message });
    console.error(`[sales-cockpit] Poll ${address.domain}:${address.variant} fehlgeschlagen: ${message}`);
  }
}

// ─── Sanity-Checks (leichtgewichtig, je Domain) ───────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertDealsOverview(snapshot: PipelineOverviewResponse): void {
  if (typeof snapshot.pipelineId !== 'string' || snapshot.pipelineId !== SALES_PIPELINE_ID) {
    throw new Error('dealsOverview: falsche pipelineId');
  }
  if (!Array.isArray(snapshot.stages) || snapshot.stages.length === 0) {
    throw new Error('dealsOverview: keine Stages');
  }
  if (!Array.isArray(snapshot.deals)) throw new Error('dealsOverview: deals kein Array');
  for (const deal of snapshot.deals) {
    if (!isFiniteNumber(deal.revenue) || deal.revenue < 0) {
      throw new Error(`dealsOverview: revenue ungültig (deal ${deal.id})`);
    }
    if (!isFiniteNumber(deal.agentsMinuten) || deal.agentsMinuten < 0) {
      throw new Error(`dealsOverview: agentsMinuten ungültig (deal ${deal.id})`);
    }
  }
}

function assertEnrichment(snapshot: DealEnrichment): void {
  if (typeof snapshot.meetings !== 'object' || typeof snapshot.stageHistory !== 'object') {
    throw new Error('dealEnrichment: maps fehlen');
  }
}

function assertLeads(snapshot: LeadsOverviewResponse): void {
  if (!Array.isArray(snapshot.leads)) throw new Error('leadsOverview: leads kein Array');
  for (const lead of snapshot.leads) {
    if (!Array.isArray(lead.associatedDealIds)) {
      throw new Error(`leadsOverview: associatedDealIds ungültig (lead ${lead.id})`);
    }
  }
}

function assertProjects(snapshot: ProjectsOverviewResponse): void {
  if (!Array.isArray(snapshot.projects)) throw new Error('projectsOverview: projects kein Array');
  if (!isFiniteNumber(snapshot.unscheduledCount) || snapshot.unscheduledCount < 0) {
    throw new Error('projectsOverview: unscheduledCount ungültig');
  }
}

function assertFunnel(snapshot: MarketingFunnelResponse): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`marketingFunnel: ${key} ungültig`);
    }
  }
}

function assertPlaybook(snapshot: PlaybookStats): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`playbookStats: ${key} ungültig`);
    }
  }
}

// ─── Poll-Funktionen ───────────────────────────────────────────────────────

/** HubSpot: Pipelines-Liste (Basis für Pipeline-Selektoren in tv/canvas). */
async function pollPipelines(): Promise<void> {
  const client = getHubSpotClient();
  const pipelines = await client.getPipelines();
  if (!Array.isArray(pipelines.results)) throw new Error('pipelines: results kein Array');
  commit(pipelinesKey, pipelines.results, (results) => {
    if (results.length === 0) throw new Error('pipelines: leer');
  });
}

/** HubSpot: Deals-Overview + Anreicherung (Meetings, Stage-History) für
 *  einen Portfolio-Wert. Die Anreicherung läuft im selben Takt auf den
 *  Deal-IDs des frischen Snapshots. */
async function pollDealsForProdukt(produkt: string): Promise<void> {
  const overview = await buildPipelineOverview(SALES_PIPELINE_ID, produkt);
  commit(dealsKey(SALES_PIPELINE_ID, produkt), overview, assertDealsOverview);

  const dealIds = overview.deals.map((d) => d.id);
  const enrichment = await buildDealEnrichment(dealIds);
  commit(enrichmentKey(SALES_PIPELINE_ID, produkt), enrichment, assertEnrichment);
}

/** HubSpot: Leads-Overview für einen Portfolio-Wert. */
async function pollLeadsForProdukt(produkt: string): Promise<void> {
  const leads = await buildLeadsOverview(produkt);
  commit(leadsKey(produkt), leads, assertLeads);
}

/** HubSpot + JIRA: Projects-Overview (Phase 1: frontdesk). */
async function pollProjects(): Promise<void> {
  const projects = await buildProjectsOverview(AI_AGENTS_PRODUKT);
  commit(projectsKey(AI_AGENTS_PRODUKT), projects, assertProjects);
}

/** Day-Windows des Marketing-Tabs: die drei Presets plus die aktiven
 *  Vergleichsfenster (×2), damit der KPI-Tree ohne Cold Path rechnet.
 *  `all` wächst täglich und wird je Lauf neu berechnet. */
function marketingWindows(): number[] {
  const windows = new Set<number>();
  for (const key of ['30', '90', 'all'] as DatePresetKey[]) {
    const days = getDaysForPreset(key);
    windows.add(days);
    if (canShowComparison(key)) windows.add(days * 2);
  }
  return [...windows].sort((a, b) => a - b);
}

/** BigQuery + HubSpot: Marketing-Funnel für ein Day-Window. */
async function pollFunnel(days: number): Promise<void> {
  const funnel = await buildMarketingFunnel(days);
  commit(funnelKey(AI_AGENTS_PRODUKT, days), funnel, assertFunnel);
}

/** BigQuery: Playbook-Adoption für ein Day-Window. */
async function pollPlaybook(days: number): Promise<void> {
  const stats = await getPlaybookStats(days);
  commit(playbookKey(days), stats, assertPlaybook);
}

// Singleton über HMR/Modul-Instanzen hinweg.
const g = globalThis as { __salesCockpitPoller?: boolean };

/** Startet den Poller (idempotent). Läuft ohne Credentials nicht und
 *  meldet das — die Routen liefern dann 503, bis der Store gefüllt ist. */
export function startPoller(): boolean {
  if (g.__salesCockpitPoller) return false;
  g.__salesCockpitPoller = true;

  const hubspotOk = !!process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!hubspotOk) {
    console.warn('[sales-cockpit] HubSpot-Polls deaktiviert: HUBSPOT_PRIVATE_APP_TOKEN fehlt.');
  }

  let jiraOk = true;
  let jiraError: string | null = null;
  if (!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN)) {
    jiraOk = false;
    jiraError = 'JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN fehlen.';
  }
  if (!jiraOk) {
    console.warn(`[sales-cockpit] Projects-Poll deaktiviert: ${jiraError}`);
  }

  let bqOk = true;
  let bqError: string | null = null;
  try {
    serviceAccountKey();
  } catch (error) {
    bqOk = false;
    bqError = error instanceof Error ? error.message : String(error);
  }
  if (!bqOk) {
    console.warn(`[sales-cockpit] BigQuery-Polls deaktiviert: ${bqError}`);
  }

  if (!hubspotOk && !jiraOk && !bqOk) return false;

  const schedule = (address: SnapshotAddress, poll: () => Promise<void>, everyMs: number) => {
    void runPoll(address, poll); // Boot-Poll sofort.
    const timer = setInterval(() => void runPoll(address, poll), everyMs);
    timer.unref?.();
  };

  if (hubspotOk) {
    schedule(pipelinesKey, pollPipelines, POLL_HUBSPOT_MS);
    for (const option of PORTFOLIO_OPTIONS) {
      schedule(dealsKey(SALES_PIPELINE_ID, option.value), () => pollDealsForProdukt(option.value), POLL_HUBSPOT_MS);
      schedule(leadsKey(option.value), () => pollLeadsForProdukt(option.value), POLL_HUBSPOT_MS);
    }
  }
  if (hubspotOk) {
    if (jiraOk) {
      schedule(projectsKey(AI_AGENTS_PRODUKT), pollProjects, POLL_PROJECTS_MS);
    }
    if (bqOk) {
      // Funnel + Playbook je Day-Window; `all` täglich neu berechnet.
      const bqTick = () => {
        for (const days of marketingWindows()) {
          void runPoll(funnelKey(AI_AGENTS_PRODUKT, days), () => pollFunnel(days));
          void runPoll(playbookKey(days), () => pollPlaybook(days));
        }
      };
      bqTick(); // Boot-Poll sofort.
      const timer = setInterval(bqTick, POLL_BQ_MS);
      timer.unref?.();
    }
  }

  return true;
}

/** Status-Dump für /health (aus dem Store). */
export { getStatuses };
