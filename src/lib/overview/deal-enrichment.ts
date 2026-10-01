// Deal-Anreicherung außerhalb des Pipeline-Overview-Builds: nächste
// Termine (Meetings) und Stage-History je Deal (aus den beiden Sub-Routen
// extrahiert, damit der Runtime-Poller beide Maps im selben Takt füllen
// kann). Beide Builder sind reine Batch-Lese-Paare — pro Deal-Set genau
// ein HubSpot-Batch-Call-Paar, nie per-Deal-Fan-out (siehe AGENTS.md).

import { getHubSpotClient } from '@/lib/hubspot/client';

// Meeting data returned by the separate meetings endpoint
export interface DealMeetingsMap {
  [dealId: string]: {
    date: string;
    title: string;
  } | null;
}

export interface DealStageHistoryEntry {
  stageId: string;
  timestamp: string;
}

export interface DealStageHistoryMap {
  [dealId: string]: {
    stageEnteredAt: string;
    daysInStage: number;
    history: DealStageHistoryEntry[];
  } | null;
}

/** Beide Maps in einem Struct, wie der Poller es im Store ablegt. */
export interface DealEnrichment {
  meetings: DealMeetingsMap;
  stageHistory: DealStageHistoryMap;
}

export async function buildMeetingsMap(dealIdList: string[]): Promise<DealMeetingsMap> {
  const client = getHubSpotClient();
  const now = new Date();

  // Single pair of batch calls instead of 2 per deal — stays inside
  // HubSpot's 10 req/s limit even for large pipelines. Previously the
  // per-deal fan-out silently swallowed 429s and cached nulls in the
  // client, which is how "no next meeting" showed up on deals that clearly
  // had one (e.g. 497714974930 "Taxi Höhne - AI Agents").
  const meetingsPerDeal = await client.getMeetingsForDeals(dealIdList);

  const meetingsMap: DealMeetingsMap = {};
  for (const dealId of dealIdList) {
    const meetings = meetingsPerDeal.get(dealId) || [];
    const upcomingMeetings = meetings
      .filter(m => {
        const startTime = m.properties.hs_meeting_start_time;
        return startTime && new Date(startTime) > now;
      })
      .sort((a, b) => {
        const aTime = new Date(a.properties.hs_meeting_start_time!).getTime();
        const bTime = new Date(b.properties.hs_meeting_start_time!).getTime();
        return aTime - bTime;
      });
    const nextMeeting = upcomingMeetings[0];
    meetingsMap[dealId] = nextMeeting
      ? {
          date: nextMeeting.properties.hs_meeting_start_time!,
          title: nextMeeting.properties.hs_meeting_title || 'Meeting',
        }
      : null;
  }
  return meetingsMap;
}

export async function buildStageHistoryMap(dealIdList: string[]): Promise<DealStageHistoryMap> {
  const client = getHubSpotClient();
  const now = new Date();

  // Single batch read with `propertiesWithHistory` instead of one GET per
  // deal — same reasoning as the meetings endpoint. See AGENTS.md "Never
  // fan out per deal — always batch".
  const historiesByDeal = await client.getDealStageHistories(dealIdList);

  const stageHistoryMap: DealStageHistoryMap = {};
  for (const dealId of dealIdList) {
    const history = historiesByDeal.get(dealId);
    if (history && history.length > 0) {
      const latestEntry = history[0];
      const stageEnteredAt = latestEntry.timestamp;
      const entered = new Date(stageEnteredAt);
      const diffTime = now.getTime() - entered.getTime();
      const daysInStage = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      stageHistoryMap[dealId] = {
        stageEnteredAt,
        daysInStage,
        history: history.map(entry => ({
          stageId: entry.value,
          timestamp: entry.timestamp,
        })),
      };
    } else {
      stageHistoryMap[dealId] = null;
    }
  }
  return stageHistoryMap;
}

/** Baut die vollständige Anreicherung (Meetings + Stage-History) für die
 *  Deal-IDs eines Pipeline-Snapshots. */
export async function buildDealEnrichment(dealIdList: string[]): Promise<DealEnrichment> {
  if (dealIdList.length === 0) return { meetings: {}, stageHistory: {} };
  const [meetings, stageHistory] = await Promise.all([
    buildMeetingsMap(dealIdList),
    buildStageHistoryMap(dealIdList),
  ]);
  return { meetings, stageHistory };
}
