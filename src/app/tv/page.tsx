'use client';

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { DealCarousel } from '@/components/tv/DealCarousel';
import { SALES_PIPELINE_ID } from '@/lib/constants';
import { Loader2 } from 'lucide-react';
import type { PipelineOverviewResponse, DealMeetingsMap } from '@/app/api/deals/overview/route';
import type { DealStageHistoryMap } from '@/app/api/deals/overview/stage-history/route';

interface Pipeline {
  id: string;
  label: string;
}

// Lost/cancelled stage keywords - these deals are filtered out
const LOST_KEYWORDS = ['closed lost', 'verloren', 'lost', 'abgesagt', 'cancelled', 'storniert'];

function isLostStage(stageName: string): boolean {
  const lower = stageName.toLowerCase();
  return LOST_KEYWORDS.some((kw) => lower.includes(kw));
}

export default function TVPage() {
  return (
    <Suspense
      fallback={
        <div
          className="h-screen w-screen flex items-center justify-center"
          style={{ backgroundColor: 'var(--gray-dark-1)' }}
        >
          <Loader2 className="h-10 w-10 animate-spin" style={{ color: 'var(--gray-dark-11)' }} />
        </div>
      }
    >
      <TVContent />
    </Suspense>
  );
}

function TVContent() {
  const searchParams = useSearchParams();
  const pipelineIdFromUrl = searchParams.get('pipelineId');
  const intervalSeconds = parseInt(searchParams.get('interval') || '10', 10);

  const [selectedPipelineIdFromPicker, setSelectedPipelineIdFromPicker] = useState<string | null>(null);
  const selectedPipelineId = pipelineIdFromUrl || selectedPipelineIdFromPicker;


  // Fetch pipelines (for selector when no pipelineId in URL)
  const { data: pipelines, isLoading: pipelinesLoading } = useQuery({
    queryKey: ['tv-pipelines'],
    queryFn: async () => {
      const res = await fetch('/api/pipelines');
      if (!res.ok) throw new Error('Failed to fetch pipelines');
      const data = await res.json();
      return data.data as Pipeline[];
    },
    enabled: !selectedPipelineId,
  });

  // Fetch pipeline overview
  const { data: overviewData, isLoading: overviewLoading } = useQuery({
    queryKey: ['tv-overview', selectedPipelineId],
    queryFn: async () => {
      const res = await fetch(
        `/api/deals/overview?pipelineId=${selectedPipelineId}`
      );
      if (!res.ok) throw new Error('Failed to fetch overview');
      const data = await res.json();
      return data.data as PipelineOverviewResponse;
    },
    enabled: !!selectedPipelineId,
    refetchInterval: 5 * 60 * 1000, // Auto-refresh every 5 minutes
  });

  // Deal IDs for meetings + stage history
  const overviewDeals = overviewData?.deals;
  const dealIds = useMemo(() => overviewDeals?.map((d) => d.id) || [], [overviewDeals]);

  // Fetch meetings
  const { data: meetingsData } = useQuery({
    queryKey: ['tv-meetings', selectedPipelineId, dealIds.join(',')],
    queryFn: async () => {
      if (dealIds.length === 0) return {} as DealMeetingsMap;
      const res = await fetch(
        `/api/deals/overview/meetings?dealIds=${dealIds.join(',')}`
      );
      if (!res.ok) throw new Error('Failed to fetch meetings');
      const data = await res.json();
      return data.data as DealMeetingsMap;
    },
    enabled: dealIds.length > 0,
    refetchInterval: 5 * 60 * 1000,
  });

  // Fetch stage history
  const { data: stageHistoryData } = useQuery({
    queryKey: ['tv-stage-history', selectedPipelineId, dealIds.join(',')],
    queryFn: async () => {
      if (dealIds.length === 0) return {} as DealStageHistoryMap;
      const res = await fetch(
        `/api/deals/overview/stage-history?dealIds=${dealIds.join(',')}`
      );
      if (!res.ok) throw new Error('Failed to fetch stage history');
      const data = await res.json();
      return data.data as DealStageHistoryMap;
    },
    enabled: dealIds.length > 0,
    refetchInterval: 5 * 60 * 1000,
  });

  // Merge data, filter closed deals, sort by revenue desc
  const deals = useMemo(() => {
    if (!overviewDeals) return [];
    return overviewDeals
      .filter((deal) => !isLostStage(deal.dealStage))
      .map((deal) => ({
        ...deal,
        nextAppointment: meetingsData?.[deal.id] || null,
        daysInStage: stageHistoryData?.[deal.id]?.daysInStage ?? -1,
        stageEnteredAt: stageHistoryData?.[deal.id]?.stageEnteredAt ?? null,
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [overviewDeals, meetingsData, stageHistoryData]);

  // Pipeline selector (when no pipelineId provided)
  if (!selectedPipelineId) {
    return (
      <div
        className="h-screen w-screen flex flex-col items-center justify-center gap-8"
        style={{ backgroundColor: 'var(--gray-dark-1)' }}
      >
        <h1
          className="text-4xl text-white"
          style={{ fontFamily: 'var(--font-headline)' }}
        >
          Pipeline auswählen
        </h1>
        {pipelinesLoading ? (
          <Loader2 className="h-8 w-8 animate-spin" style={{ color: 'var(--gray-dark-11)' }} />
        ) : (
          <div className="flex flex-col gap-3 min-w-[300px]">
            {/* Nur die Sales-Pipeline: Der Runtime-Poller baut die Overview
                ausschließlich für sie (je Portfolio-Wert), alle anderen
                Pipelines hätten im Store keinen Snapshot (404). */}
            {pipelines
              ?.filter((pipeline) => pipeline.id === SALES_PIPELINE_ID)
              .map((pipeline) => (
              <button
                key={pipeline.id}
                onClick={() => setSelectedPipelineIdFromPicker(pipeline.id)}
                className="px-6 py-4 rounded-xl text-lg text-white text-left transition-colors"
                style={{
                  backgroundColor: 'var(--gray-dark-3)',
                  fontFamily: 'var(--font-primary)',
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.backgroundColor = 'var(--gray-dark-5)')
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.backgroundColor = 'var(--gray-dark-3)')
                }
              >
                {pipeline.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Loading state
  if (overviewLoading) {
    return (
      <div
        className="h-screen w-screen flex flex-col items-center justify-center gap-4"
        style={{ backgroundColor: 'var(--gray-dark-1)' }}
      >
        <Loader2 className="h-10 w-10 animate-spin" style={{ color: '#DEFF00' }} />
        <p style={{ color: 'var(--gray-dark-11)', fontFamily: 'var(--font-primary)' }}>
          Deals werden geladen...
        </p>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: 'var(--gray-dark-1)' }}>
      <DealCarousel deals={deals} intervalSeconds={intervalSeconds} />
    </div>
  );
}
