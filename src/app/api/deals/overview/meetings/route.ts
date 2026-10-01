// Meetings: dünner Store-Reader. Die Maps baut der Hintergrund-Poller je
// Portfolio-Variante (src/lib/overview/deal-enrichment.ts); dieser Handler
// merged über alle Varianten und liefert den angefragten Deal-Subset.

import { NextResponse } from 'next/server';
import { getDomainSnapshots } from '@/lib/runtime/store';
import type { DealEnrichment, DealMeetingsMap } from '@/lib/overview/deal-enrichment';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dealIds = searchParams.get('dealIds');

    if (!dealIds) {
      return NextResponse.json(
        { error: 'dealIds is required' },
        { status: 400 }
      );
    }

    const dealIdList = dealIds.split(',').filter(Boolean);
    if (dealIdList.length === 0) {
      return NextResponse.json({
        success: true,
        data: {},
      });
    }

    // Über alle produkt-Varianten mergen: derselbe Deal kann in mehreren
    // Snapshots auftauchen, die Meeting-Daten sind je Deal identisch.
    const merged: DealMeetingsMap = {};
    let anySnapshot = false;
    for (const enrichment of getDomainSnapshots<DealEnrichment>('dealEnrichment').values()) {
      anySnapshot = true;
      for (const dealId of dealIdList) {
        if (dealId in enrichment.meetings && !(dealId in merged)) {
          merged[dealId] = enrichment.meetings[dealId];
        }
      }
    }

    if (!anySnapshot) {
      return NextResponse.json(
        { success: false, warming: true, error: 'Store is warming up, retry shortly.' },
        { status: 503, headers: { 'Retry-After': '10' } }
      );
    }

    return NextResponse.json({
      success: true,
      data: merged,
    });
  } catch (error) {
    console.error('Error reading meetings from store:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to read meetings', details: errorMessage },
      { status: 500 }
    );
  }
}
