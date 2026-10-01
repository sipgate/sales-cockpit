// Stage-History: dünner Store-Reader. Die Maps baut der Hintergrund-Poller
// je Portfolio-Variante (src/lib/overview/deal-enrichment.ts); dieser
// Handler merged über alle Varianten und liefert den angefragten Deal-Subset.

import { NextResponse } from 'next/server';
import { getDomainSnapshots } from '@/lib/runtime/store';
import type { DealEnrichment, DealStageHistoryMap } from '@/lib/overview/deal-enrichment';

// Typ-Re-Exports: Komponenten importieren die Typen historisch über diese
// Route; die Definitionen leben jetzt im Builder-Modul.
export type { DealStageHistoryEntry, DealStageHistoryMap } from '@/lib/overview/deal-enrichment';

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
    // Snapshots auftauchen, die Stage-History ist je Deal identisch.
    const merged: DealStageHistoryMap = {};
    let anySnapshot = false;
    for (const enrichment of getDomainSnapshots<DealEnrichment>('dealEnrichment').values()) {
      anySnapshot = true;
      for (const dealId of dealIdList) {
        if (dealId in enrichment.stageHistory && !(dealId in merged)) {
          merged[dealId] = enrichment.stageHistory[dealId];
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
    console.error('Error reading stage history from store:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to read stage history', details: errorMessage },
      { status: 500 }
    );
  }
}
