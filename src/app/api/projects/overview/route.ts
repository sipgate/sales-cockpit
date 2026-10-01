// Projects-Overview: dünner Store-Reader. Der Build (HubSpot + JIRA) läuft
// im Hintergrund-Poller (src/lib/runtime/poller.ts → buildProjectsOverview
// in src/lib/overview/projects.ts).

import { NextResponse } from 'next/server';
import { getSnapshotWithStand, projectsKey } from '@/lib/runtime/store';
import type { ProjectsOverviewResponse } from '@/lib/overview/projects';
import { AI_AGENTS_PRODUKT } from '@/lib/constants';

// Typ-Re-Exports (historische Import-Pfade der Komponenten).
export type {
  ProjectOverviewItem,
  ProjectsOverviewResponse,
  ProjectDateSource,
} from '@/lib/overview/projects';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    // Phase 1 is AI-Agents-only — keep the route product-aware so we can lift
    // this restriction later without an API break.
    const produkt = searchParams.get('produkt') ?? 'frontdesk';
    if (produkt !== 'frontdesk') {
      return NextResponse.json(
        { error: 'Projects view is currently only available for AI Agents (produkt=frontdesk).' },
        { status: 400 },
      );
    }

    const entry = getSnapshotWithStand<ProjectsOverviewResponse>(projectsKey(produkt));

    // Cold Store: Boot-Poll läuft, noch kein Snapshot. Client soll kurz
    // erneut versuchen.
    if (!entry) {
      return NextResponse.json(
        { success: false, warming: true, error: 'Store is warming up, retry shortly.' },
        { status: 503, headers: { 'Retry-After': '10' } }
      );
    }

    return NextResponse.json({ success: true, data: entry.snapshot, stand: entry.stand });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
