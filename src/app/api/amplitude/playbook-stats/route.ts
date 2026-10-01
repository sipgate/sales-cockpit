// Playbook-Stats: dünner Store-Reader. Der Build (Amplitude BigQuery)
// läuft im Hintergrund-Poller (src/lib/runtime/poller.ts →
// getPlaybookStats), je Day-Window.

import { NextResponse } from 'next/server';
import { getSnapshotWithStand, playbookKey } from '@/lib/runtime/store';
import type { PlaybookStats } from '@/lib/amplitude/playbook-stats';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    // Muss einem gepollten Window entsprechen (UI-Presets 30/90/all,
    // Vergleichsfenster ×2). Default 90 Tage.
    const daysRaw = Number(searchParams.get('days'));
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? daysRaw : 90;

    const entry = getSnapshotWithStand<PlaybookStats>(playbookKey(days));

    if (!entry) {
      return NextResponse.json(
        { success: false, warming: true, error: 'Store is warming up, retry shortly.' },
        { status: 503, headers: { 'Retry-After': '10' } }
      );
    }

    return NextResponse.json({ success: true, data: entry.snapshot, stand: entry.stand });
  } catch (err) {
    console.error('[playbook-stats]', err);
    return NextResponse.json(
      { error: 'Failed to read playbook stats' },
      { status: 500 },
    );
  }
}
