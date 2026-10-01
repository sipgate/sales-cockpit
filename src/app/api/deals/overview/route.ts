// Pipeline-Overview: dünner Store-Reader. Der Build läuft im
// Hintergrund-Poller (src/lib/runtime/poller.ts → buildPipelineOverview
// in src/lib/overview/deals.ts); dieser Handler liest nur den Snapshot.

import { NextResponse } from 'next/server';
import { dealsKey, getSnapshotWithStand, hasVariant } from '@/lib/runtime/store';
import type { PipelineOverviewResponse } from '@/lib/overview/deals';
import { PipelineNotFoundError } from '@/lib/overview/deals';

// Typ-Re-Exports: Komponenten und MCP importieren die Typen historisch
// über diese Route; die Definitionen leben jetzt im Builder-Modul.
export type {
  DealOverviewItem,
  PipelineOverviewResponse,
  RevenueSource,
  IcpTier,
} from '@/lib/overview/deals';
export type { DealMeetingsMap } from '@/lib/overview/deal-enrichment';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const pipelineId = searchParams.get('pipelineId');
    const produkt = searchParams.get('produkt');

    if (!pipelineId) {
      return NextResponse.json(
        { error: 'pipelineId is required' },
        { status: 400 }
      );
    }

    const address = dealsKey(pipelineId, produkt);
    const entry = getSnapshotWithStand<PipelineOverviewResponse>(address);

    if (!entry) {
      // Pipeline, die der Poller nie bedient → 404 wie bisher
      // (PipelineNotFoundError). Nur bekannte Varianten antworten 503,
      // solange der Boot-Poll noch läuft.
      if (!hasVariant(address)) {
        return NextResponse.json(
          { error: new PipelineNotFoundError(pipelineId).message },
          { status: 404 },
        );
      }
      return NextResponse.json(
        { success: false, warming: true, error: 'Store is warming up, retry shortly.' },
        { status: 503, headers: { 'Retry-After': '10' } }
      );
    }

    return NextResponse.json({
      success: true,
      data: entry.snapshot,
      stand: entry.stand,
    });
  } catch (error) {
    console.error('Error reading pipeline overview from store:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to read pipeline overview', details: errorMessage },
      { status: 500 }
    );
  }
}
