// Pipelines: dünner Store-Reader. Die HubSpot-Abfrage läuft im
// Hintergrund-Poller (src/lib/runtime/poller.ts → pollPipelines).

import { NextResponse } from 'next/server';
import { getSnapshotWithStand, pipelinesKey } from '@/lib/runtime/store';

export async function GET() {
  try {
    // Volle HubSpot-Pipeline-Objekte (id, label, stages, …) — unverändert
    // durchgereicht, tv/canvas lesen u.a. die Stages daraus.
    const entry = getSnapshotWithStand<unknown[]>(pipelinesKey);

    if (!entry) {
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
    console.error('Error reading pipelines from store:', error);
    return NextResponse.json(
      { error: 'Failed to read pipelines' },
      { status: 500 }
    );
  }
}
