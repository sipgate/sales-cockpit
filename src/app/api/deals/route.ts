import { NextResponse } from 'next/server';
import { getHubSpotClient } from '@/lib/hubspot/client';

export async function GET(request: Request) {
  try {

    const { searchParams } = new URL(request.url);
    const pipelineId = searchParams.get('pipelineId') || undefined;

    const client = getHubSpotClient();
    const deals = await client.getDeals(pipelineId);

    return NextResponse.json({
      success: true,
      data: deals.results,
    });
  } catch (error) {
    console.error('Error fetching deals:', error);
    return NextResponse.json(
      { error: 'Failed to fetch deals' },
      { status: 500 }
    );
  }
}
