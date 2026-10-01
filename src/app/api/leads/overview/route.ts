// Leads-Overview: dünner Store-Reader. Der Build (~35–50 s HubSpot-Fan-out)
// läuft im Hintergrund-Poller (src/lib/runtime/poller.ts →
// buildLeadsOverview in src/lib/overview/leads.ts).

import { NextResponse } from 'next/server';
import { getSnapshotWithStand, leadsKey } from '@/lib/runtime/store';
import type { LeadsOverviewResponse } from '@/lib/overview/leads';

// Typ-Re-Exports (historische Import-Pfade der Komponenten).
export type { LeadOverviewItem, LeadsOverviewResponse } from '@/lib/overview/leads';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const produkt = searchParams.get('produkt');

    const entry = getSnapshotWithStand<LeadsOverviewResponse>(leadsKey(produkt));

    // Cold Store: Boot-Poll läuft, aber für diese Variante liegt noch kein
    // Snapshot vor. Client soll kurz erneut versuchen.
    if (!entry) {
      return NextResponse.json(
        { success: false, warming: true, error: 'Store is warming up, retry shortly.' },
        { status: 503, headers: { 'Retry-After': '10' } }
      );
    }

    return NextResponse.json({ success: true, data: entry.snapshot, stand: entry.stand });
  } catch (error) {
    console.error('Error reading leads overview from store:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to read leads overview', details: errorMessage },
      { status: 500 }
    );
  }
}
