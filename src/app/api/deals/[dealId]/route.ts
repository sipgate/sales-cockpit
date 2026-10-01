import { NextResponse } from 'next/server';
import { getHubSpotClient } from '@/lib/hubspot/client';
import { mapHubSpotToCanvas, mapCanvasToHubSpot } from '@/lib/hubspot/mapper';
import type { CanvasData } from '@/types/canvas';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ dealId: string }> }
) {
  try {

    const { dealId } = await params;
    const client = getHubSpotClient();

    // Fetch deal with associations
    const deal = await client.getDeal(dealId);

    // Fetch associated contacts
    let contacts: Array<{ id: string; properties: Record<string, string> }> = [];
    if (deal.associations?.contacts?.results) {
      const contactIds = deal.associations.contacts.results.map((c) => c.id);
      if (contactIds.length > 0) {
        const contactsResponse = await client.getContacts(contactIds);
        contacts = contactsResponse.results;
      }
    }

    // Fetch associated company
    let company: { id: string; properties: Record<string, string> } | undefined;
    if (deal.associations?.companies?.results?.[0]) {
      company = await client.getCompany(deal.associations.companies.results[0].id);
    }

    // Fetch owners for internal contacts
    const ownersResponse = await client.getOwners();

    // Fetch pipeline to resolve stage label
    let stageLabel: string | undefined;
    if (deal.properties.pipeline && deal.properties.dealstage) {
      try {
        const pipelinesResponse = await client.getPipelines();
        const pipeline = pipelinesResponse.results.find(p => p.id === deal.properties.pipeline);
        if (pipeline) {
          const stage = pipeline.stages.find(s => s.id === deal.properties.dealstage);
          stageLabel = stage?.label;
        }
      } catch {
        // Pipeline fetch failed, continue without stage label
      }
    }

    // Fetch meetings for next appointment
    let meetings: Array<{
      id: string;
      properties: {
        hs_meeting_title?: string;
        hs_meeting_start_time?: string;
        hs_meeting_end_time?: string;
      };
    }> = [];
    try {
      const meetingsResponse = await client.getMeetingsForDeal(dealId);
      meetings = meetingsResponse.results;
    } catch {
      // Meetings might not be accessible, continue without them
    }

    // Map to canvas format
    const canvasData = mapHubSpotToCanvas({
      id: deal.id,
      properties: deal.properties,
      contacts,
      company,
      owners: ownersResponse.results,
      meetings,
      stageLabel,
    });

    return NextResponse.json({
      success: true,
      data: canvasData,
    });
  } catch (error) {
    console.error('Error fetching deal:', error);
    return NextResponse.json(
      { error: 'Failed to fetch deal' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ dealId: string }> }
) {
  try {

    const { dealId } = await params;
    const canvasData: CanvasData = await request.json();

    const client = getHubSpotClient();

    // Map canvas data to HubSpot properties
    const properties = mapCanvasToHubSpot(canvasData);

    // Update the deal
    const updatedDeal = await client.updateDeal(dealId, properties);

    return NextResponse.json({
      success: true,
      data: updatedDeal,
    });
  } catch (error) {
    console.error('Error updating deal:', error);
    return NextResponse.json(
      { error: 'Failed to update deal' },
      { status: 500 }
    );
  }
}
