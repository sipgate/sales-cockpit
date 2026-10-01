// Marketing-Funnel: dünner Store-Reader. Der Build (BigQuery + HubSpot,
// ~35–50 s) läuft im Hintergrund-Poller (src/lib/runtime/poller.ts →
// buildMarketingFunnel in src/lib/overview/marketing-funnel.ts), je
// Day-Window (UI-Presets 30/90/all plus Vergleichsfenster ×2).

import { NextResponse } from 'next/server';
import { funnelKey, getSnapshotWithStand } from '@/lib/runtime/store';
import { type MarketingFunnelResponse } from '@/lib/marketing/funnel-types';
import { AI_AGENTS_PRODUKT } from '@/lib/constants';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const produkt = searchParams.get('produkt');
    if (produkt !== 'frontdesk') {
      return NextResponse.json(
        { error: 'Marketing funnel is currently only available for AI Agents (produkt=frontdesk).' },
        { status: 400 },
      );
    }

    // Funnel-Datums-Fenster — muss einem gepollten Window entsprechen
    // (UI-Presets 30/90/all, Vergleichsfenster ×2). Default 90 Tage.
    const daysRaw = Number(searchParams.get('days'));
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? daysRaw : 90;

    const entry = getSnapshotWithStand<MarketingFunnelResponse>(
      funnelKey(AI_AGENTS_PRODUKT, days),
    );

    // Cold Store: Boot-Poll läuft, für dieses Window liegt noch kein Snapshot
    // vor. Client soll kurz erneut versuchen.
    if (!entry) {
      return NextResponse.json(
        { success: false, warming: true, error: 'Store is warming up, retry shortly.' },
        { status: 503, headers: { 'Retry-After': '10' } }
      );
    }

    return NextResponse.json({ success: true, data: entry.snapshot, stand: entry.stand });
  } catch (error) {
    console.error('Error reading marketing funnel from store:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to read marketing funnel', details: errorMessage },
      { status: 500 },
    );
  }
}
