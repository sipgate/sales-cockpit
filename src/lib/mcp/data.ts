// Internal data client für den MCP-Server: liest direkt aus dem
// Runtime-Store (gefüllt vom Hintergrund-Poller, siehe
// src/lib/runtime/poller.ts). Kein Self-Fetch über HTTP mehr — die Tools
// lesen byte-identisch die Snapshots, die auch die API-Routen ausliefern.

import type { PipelineOverviewResponse } from '@/lib/overview/deals';
import type { LeadsOverviewResponse } from '@/lib/overview/leads';
import type { ProjectsOverviewResponse } from '@/lib/overview/projects';
import type { MarketingFunnelResponse } from '@/lib/marketing/funnel-types';
import type { PlaybookStats } from '@/lib/amplitude/playbook-stats';
import {
  dealsKey,
  funnelKey,
  getSnapshot,
  leadsKey,
  playbookKey,
  projectsKey,
  type SnapshotAddress,
} from '@/lib/runtime/store';
import { SALES_PIPELINE_ID, AI_AGENTS_PRODUKT } from '@/lib/constants';

export { AI_AGENTS_PRODUKT };

function readSnapshot<T>(address: SnapshotAddress): T {
  const snapshot = getSnapshot<T>(address);
  if (snapshot == null) {
    throw new Error(
      `Store ist für diese Variante noch kalt (Boot-Poll läuft): ` +
        `${address.domain}:${address.variant}. Kurz erneut versuchen.`,
    );
  }
  return snapshot;
}

export function fetchDealsOverview(produkt: string = AI_AGENTS_PRODUKT): Promise<PipelineOverviewResponse> {
  return Promise.resolve(readSnapshot<PipelineOverviewResponse>(dealsKey(SALES_PIPELINE_ID, produkt)));
}

export function fetchLeadsOverview(produkt: string = AI_AGENTS_PRODUKT): Promise<LeadsOverviewResponse> {
  return Promise.resolve(readSnapshot<LeadsOverviewResponse>(leadsKey(produkt)));
}

export function fetchProjectsOverview(produkt: string = AI_AGENTS_PRODUKT): Promise<ProjectsOverviewResponse> {
  return Promise.resolve(readSnapshot<ProjectsOverviewResponse>(projectsKey(produkt)));
}

export function fetchMarketingFunnel(days: number, produkt: string = AI_AGENTS_PRODUKT): Promise<MarketingFunnelResponse> {
  return Promise.resolve(readSnapshot<MarketingFunnelResponse>(funnelKey(produkt, days)));
}

export function fetchPlaybookStats(days: number): Promise<PlaybookStats> {
  return Promise.resolve(readSnapshot<PlaybookStats>(playbookKey(days)));
}
