'use client';

import { Suspense, useCallback, useEffect, useState, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { DealStageGroup } from '@/components/pipeline/DealStageGroup';
import { DealListView } from '@/components/pipeline/DealListView';
import { DashboardView } from '@/components/pipeline/DashboardView';
import { SpreadsheetView } from '@/components/pipeline/SpreadsheetView';
import { LeadsSection } from '@/components/pipeline/LeadsSection';
import { LeadsSpreadsheetView } from '@/components/pipeline/LeadsSpreadsheetView';
import { ProjectsView } from '@/components/pipeline/ProjectsView';
import {
  FilterBuilder,
  Tab,
  TabBar,
  getDefaultFilterState,
  loadFilterSets,
  saveFilterSets,
  makeId,
  combineFilterWithBadges,
  loadActiveBadgeIds,
  saveActiveBadgeIds,
} from '@sipgate/revop-ui';
import type {
  FilterBadge,
  FilterState,
  SavedFilterSet,
} from '@sipgate/revop-ui';
import {
  DEAL_DEFAULT_FIELD,
  buildDealFieldConfigs,
  getDealInputKind,
  applyDealFilters,
} from '@/components/pipeline/filters/dealFilters';
import type { DealFieldType } from '@/components/pipeline/filters/dealFilters';
import {
  LEAD_DEFAULT_FIELD,
  buildLeadFieldConfigs,
  getLeadInputKind,
  applyLeadFilters,
} from '@/components/pipeline/filters/leadFilters';
import type { LeadFieldType } from '@/components/pipeline/filters/leadFilters';
import { Loader2, LayoutGrid, RefreshCw, BarChart3, Table2, Users, Calendar, Megaphone, Network } from 'lucide-react';
import type { PipelineOverviewResponse, DealOverviewItem, DealMeetingsMap } from '@/app/api/deals/overview/route';
import type { DealStageHistoryMap } from '@/app/api/deals/overview/stage-history/route';
import type { LeadsOverviewResponse, LeadOverviewItem } from '@/app/api/leads/overview/route';
import type { ProjectsOverviewResponse } from '@/app/api/projects/overview/route';
import { MRR_BUCKET_THRESHOLD, type MarketingFunnelResponse } from '@/lib/marketing/funnel-types';
import { buildJourneyMap } from '@/lib/leads/classify';
import type { PlaybookStats } from '@/lib/amplitude/playbook-stats';
import {
  getActivationLabel,
} from '@/lib/marketing/touchpoint-label';
import { MarketingView } from '@/components/pipeline/MarketingView';
import { KpiTreeView } from '@/components/pipeline/KpiTreeView';
import {
  type DatePresetKey as MarketingDatePresetKey,
  getDaysForPreset as getMarketingDaysForPreset,
  canShowComparison,
} from '@/lib/marketing/date-presets';
import { PORTFOLIO_OPTIONS, SALES_PIPELINE_ID, type PortfolioValue } from '@/lib/constants';

// localStorage-Prefixe für die pro-Tab gespeicherten Filter-Sets und die
// aktiv geschalteten Badges. Pipeline/Produkt fließen mit ein, damit jeder
// Portfolio-Tab seine eigenen Sets und Badge-Zustände behält.
const DEALS_TAB_FILTERSETS_PREFIX = 'deals-tab-filtersets-';
const LEADS_TAB_FILTERSETS_PREFIX = 'leads-tab-filtersets-';
const DEALS_TAB_ACTIVE_BADGES_PREFIX = 'deals-tab-active-badges-';
const LEADS_TAB_ACTIVE_BADGES_PREFIX = 'leads-tab-active-badges-';

// IDs der System-Badges. Müssen konstant bleiben, damit ein einmal aktiv
// geschaltetes System-Badge nach Reload wieder aktiv ist.
const DEAL_SYSTEM_BADGE_OPEN = 'system:deals-open';
const DEAL_SYSTEM_BADGE_MIN_MRR = 'system:deals-min-mrr-450';
const DEAL_SYSTEM_BADGE_ICP_S1 = 'system:deals-icp-s1';
const DEAL_SYSTEM_BADGE_ICP_S2 = 'system:deals-icp-s2';
const DEAL_SYSTEM_BADGE_ICP_S3 = 'system:deals-icp-s3';
const DEAL_SYSTEM_BADGE_ICP_S4 = 'system:deals-icp-s4';
const DEAL_SYSTEM_BADGE_COUNTRY_DE = 'system:deals-country-de';
const LEAD_SYSTEM_BADGE_OPEN = 'system:leads-open';
const LEAD_SYSTEM_BADGE_MIN_1000 = 'system:leads-min-1000';
const LEAD_SYSTEM_BADGE_MIN_2000 = 'system:leads-min-2000';
const LEAD_SYSTEM_BADGE_NO_DEAL = 'system:leads-no-deal';

function isPortfolioValue(value: string | null): value is PortfolioValue {
  return PORTFOLIO_OPTIONS.some(option => option.value === value);
}

export type SortField = 'revenue' | 'agentsMinuten' | 'dealAge' | 'daysInStage' | 'nextAppointment' | 'closedDate';
export type SortDirection = 'asc' | 'desc';
export type ViewMode = 'deals' | 'dashboard' | 'leads' | 'projects' | 'marketing' | 'kpi-tree';
// Sub-Modus innerhalb Deals- und Leads-Tab: Sales-Sicht (Kachel-/Listenansicht
// mit Story) oder Sheet (tabellarisch, mit CSV-Export). Wird pro Tab separat
// gehalten, damit ein Wechsel zwischen Deals und Leads die gewählte Sicht nicht
// zurücksetzt.
export type ContentMode = 'sales' | 'sheet';
export type DealsGrouping = 'stage' | 'none';

export default function PipelineOverview() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    }>
      <PipelineOverviewContent />
    </Suspense>
  );
}

function PipelineOverviewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const selectedPipelineId = SALES_PIPELINE_ID;
  const [sortByStage, setSortByStage] = useState<Record<string, { field: SortField; direction: SortDirection }>>({});
  // Hydration-Guard: Der SSR-Render kennt keine Query-Ergebnisse, der
  // initiale Client-Render erst nach dem ersten Effect. Damit der erste
  // Client-Render identisch zum Server-HTML bleibt, gaten wir
  // loading-abhängige UI hinter `hydrated`.
  const [hydrated, setHydrated] = useState(false);
  // Klassisches "mounted"-Pattern: `setHydrated(true)` direkt im Effect ist
  // hier gewollt (genau einmal nach Mount), nicht der von der ESLint-Regel
  // beanstandete State-Sync-Fall.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setHydrated(true); }, []);
  // Getrennte Sub-View-States für Deals und Leads — so merkt sich jeder Tab
  // seine zuletzt gewählte Sicht (Sales vs. Sheet) auch beim Hin- und
  // Herspringen zwischen den Tabs.
  const [dealsSubView, setDealsSubView] = useState<ContentMode>('sales');
  const [leadsSubView, setLeadsSubView] = useState<ContentMode>('sales');
  const [grouping, setGrouping] = useState<DealsGrouping>('stage');
  const [listSortConfig, setListSortConfig] = useState<{ field: SortField; direction: SortDirection }>({ field: 'revenue', direction: 'desc' });

  // Deals-Tab- und Leads-Tab-Filter (dasselbe Modell wie der Dashboard-Filter,
  // nur pro Tab eigene State-Instanzen + eigene gespeicherte Filter-Sets).
  const [dealsFilter, setDealsFilter] = useState<FilterState<DealFieldType>>(() => getDefaultFilterState<DealFieldType>());
  const [dealsSavedSets, setDealsSavedSets] = useState<SavedFilterSet<DealFieldType>[]>([]);
  const [leadsFilter, setLeadsFilter] = useState<FilterState<LeadFieldType>>(() => getDefaultFilterState<LeadFieldType>());
  const [leadsSavedSets, setLeadsSavedSets] = useState<SavedFilterSet<LeadFieldType>[]>([]);

  const selectedProdukt = useMemo(() => {
    const produktFromUrl = searchParams.get('produkt');
    return isPortfolioValue(produktFromUrl) ? produktFromUrl : PORTFOLIO_OPTIONS[0].value;
  }, [searchParams]);

  // viewMode kommt aus der URL (?view=...). Default ist 'dashboard'. So bleibt
  // der aktive Tab bei Reload/Share-Link erhalten, und Browser-Back/Forward
  // springt zwischen Tabs.
  const viewMode = useMemo<ViewMode>(() => {
    const v = searchParams.get('view');
    if (v === 'deals' || v === 'leads' || v === 'projects' || v === 'dashboard' || v === 'marketing' || v === 'kpi-tree') return v;
    return 'dashboard';
  }, [searchParams]);

  // Aktualisiert URL-Parameter, ohne andere zu verlieren. Wird sowohl für
  // Produktwechsel als auch für Tab-Wechsel benutzt.
  const updateUrlParams = useCallback(
    (updates: Partial<{ produkt: PortfolioValue; view: ViewMode }>) => {
      const params = new URLSearchParams(searchParams.toString());
      if (updates.produkt) params.set('produkt', updates.produkt);
      if (updates.view) {
        if (updates.view === 'dashboard') params.delete('view');
        else params.set('view', updates.view);
      }
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : '/', { scroll: false });
    },
    [router, searchParams],
  );

  const handleProduktChange = (produkt: PortfolioValue) => {
    updateUrlParams({ produkt });
  };

  const setViewMode = useCallback(
    (view: ViewMode) => {
      updateUrlParams({ view });
    },
    [updateUrlParams],
  );

  // Wenn das Produkt von AI Agents weg gewechselt wird, während gerade die
  // Projekte- oder Marketing-Ansicht aktiv ist (beide sind frontdesk-only),
  // fallen wir effektiv auf das Dashboard zurück. Wir leiten den effektiven
  // View-Mode aus URL + Produkt ab — die Tabs werden gleichzeitig ausgeblendet.
  const effectiveViewMode: ViewMode =
    (viewMode === 'projects' || viewMode === 'marketing' || viewMode === 'kpi-tree') && selectedProdukt !== 'frontdesk'
      ? 'dashboard'
      : viewMode;

  // Fetch pipeline overview filtered by product (server-side)
  const { data: overviewData, isLoading: overviewLoading, error: overviewError } = useQuery({
    queryKey: ['pipeline-overview', selectedPipelineId, selectedProdukt],
    queryFn: async () => {
      const response = await fetch(`/api/deals/overview?pipelineId=${selectedPipelineId}&produkt=${selectedProdukt}`);
      if (!response.ok) throw new Error('Failed to fetch pipeline overview');
      const data = await response.json();
      const result = data.data as PipelineOverviewResponse;
      return result;
    },
    enabled: !!selectedPipelineId && !!selectedProdukt,
    staleTime: 5 * 60 * 1000
  });
  const overviewDeals = overviewData?.deals;
  const overviewStages = overviewData?.stages;

  // Fetch leads for the selected portfolio (separate CRM object, own pipeline).
  const { data: leadsData, isLoading: leadsLoading } = useQuery({
    queryKey: ['pipeline-leads', selectedProdukt],
    queryFn: async () => {
      const response = await fetch(`/api/leads/overview?produkt=${selectedProdukt}`);
      if (!response.ok) throw new Error('Failed to fetch leads overview');
      const data = await response.json();
      const result = data.data as LeadsOverviewResponse;
      return result;
    },
    enabled: !!selectedProdukt,
    staleTime: 5 * 60 * 1000,
    // Cold-Start: der Server antwortet 503 "warming" solange der Boot-Poll
    // den Store noch nicht gefüllt hat. Lang genug retryen (12×10s ≈ 2min),
    // statt sofort einen Fehler zu zeigen.
    retry: 12,
    retryDelay: 10_000
  });

  // Projects (Wochenansicht) — bisher nur für AI Agents implementiert. Andere
  // Produkte haben weder das `jira_story`-Property noch ein "Ende der
  // Testphase"-Feld am passenden JIRA-Issue, daher beschränken wir den Tab
  // serverseitig (400) und clientseitig (Tab versteckt) auf produkt=frontdesk.
  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ['projects-overview', selectedProdukt],
    queryFn: async () => {
      const response = await fetch(`/api/projects/overview?produkt=${selectedProdukt}`);
      if (!response.ok) throw new Error('Failed to fetch projects overview');
      const data = await response.json();
      const result = data.data as ProjectsOverviewResponse;
      return result;
    },
    enabled: selectedProdukt === 'frontdesk',
    staleTime: 5 * 60 * 1000
  });

  // Date-Preset für die Marketing-Tab (Sankey/Funnel/Tabelle). State liegt
  // hier oben, weil die Marketing-Funnel-Query (BQ-Roundtrip) das Window
  // braucht — sonst müssten wir bei jedem Preset-Wechsel doppelt fetchen.
  const [marketingDatePresetKey, setMarketingDatePresetKey] =
    useState<MarketingDatePresetKey>('90');
  const marketingDays = getMarketingDaysForPreset(marketingDatePresetKey);
  // Marketing-Funnel: AI-Agents-only, lazy — wir lassen die Query nur laufen
  // wenn der Marketing-Tab aktiv ist UND das Produkt frontdesk ist. Spart den
  // (vom Poller ohnehin im Hintergrund gebauten) Funnel-Abruf beim Mount.
  const { data: marketingData, isLoading: marketingLoading, isFetching: marketingFetching } = useQuery({
    queryKey: ['marketing-funnel', selectedProdukt, marketingDays],
    queryFn: async () => {
      const response = await fetch(
        `/api/marketing/funnel?produkt=${selectedProdukt}&days=${marketingDays}`,
      );
      if (!response.ok) throw new Error('Failed to fetch marketing funnel');
      const data = await response.json();
      const result = data.data as MarketingFunnelResponse;
      return result;
    },
    // Dashboard nutzt die Journey-Daten zur Gruppierung des Prospects-Charts
    // nach erstem Marketing-Touchpoint — daher auch im Dashboard-Tab laden.
    // KPI-Tree braucht bqTotals + Journeys für Signup-/Trial-/Lead-Metriken.
    enabled:
      selectedProdukt === 'frontdesk' &&
      (effectiveViewMode === 'marketing' || effectiveViewMode === 'dashboard' || effectiveViewMode === 'kpi-tree'),
    staleTime: 30 * 60 * 1000,
    // Cold-Start: 503 "warming" überbrücken bis der Boot-Poll das
    // Funnel-Window gefüllt hat. Siehe Leads-Query oben.
    retry: 12,
    retryDelay: 10_000,
    // Beim Date-Preset-Wechsel die vorherigen Daten im UI lassen statt
    // Loading-Spinner zu zeigen. Marketing-Touch zeigt kurz die alten Zahlen,
    // dann liest sich das Diagramm sauber zur neuen Auflösung um.
    placeholderData: keepPreviousData
  });

  // Background-Prefetch der anderen Date-Preset-Windows, damit ein
  // Preset-Wechsel danach instant ist (Server-Cache lebt 30 min).
  // Läuft nur wenn die aktuelle Marketing-Query schon fertig ist und
  // wir im Marketing-/Dashboard-Tab sind.
  useEffect(() => {
    if (!marketingData || selectedProdukt !== 'frontdesk') return;
    if (effectiveViewMode !== 'marketing' && effectiveViewMode !== 'dashboard' && effectiveViewMode !== 'kpi-tree') return;
    const allKeys: MarketingDatePresetKey[] = ['30', '90', 'all'];
    for (const key of allKeys) {
      if (key === marketingDatePresetKey) continue;
      const days = getMarketingDaysForPreset(key);
      queryClient.prefetchQuery({
        queryKey: ['marketing-funnel', selectedProdukt, days],
        queryFn: async () => {
          const response = await fetch(
            `/api/marketing/funnel?produkt=${selectedProdukt}&days=${days}`,
          );
          if (!response.ok) throw new Error('Prefetch failed');
          const data = await response.json();
          return data.data as MarketingFunnelResponse;
        },
        staleTime: 30 * 60 * 1000,
      });
    }
  }, [marketingData, marketingDatePresetKey, selectedProdukt, effectiveViewMode, queryClient]);

  // Playbook-Stats (Amplitude BQ) — für KPI-Tree Node "3+ Playbooks".
  const { data: playbookStats } = useQuery({
    queryKey: ['playbook-stats', marketingDays],
    queryFn: async () => {
      const response = await fetch(`/api/amplitude/playbook-stats?days=${marketingDays}`);
      if (!response.ok) throw new Error('Failed to fetch playbook stats');
      const json = await response.json();
      return json.data as PlaybookStats;
    },
    enabled: effectiveViewMode === 'kpi-tree',
    staleTime: 30 * 60 * 1000,
  });

  // Comparison period: fetch 2× the current window so the KPI tree can
  // subtract current from doubled to get the previous period's values.
  const showKpiComparison = canShowComparison(marketingDatePresetKey);
  const comparisonDays = marketingDays * 2;

  const { data: doubledMarketingData } = useQuery({
    queryKey: ['marketing-funnel', selectedProdukt, comparisonDays],
    queryFn: async () => {
      const response = await fetch(
        `/api/marketing/funnel?produkt=${selectedProdukt}&days=${comparisonDays}`,
      );
      if (!response.ok) throw new Error('Failed to fetch comparison marketing');
      const data = await response.json();
      return data.data as MarketingFunnelResponse;
    },
    enabled: selectedProdukt === 'frontdesk' && effectiveViewMode === 'kpi-tree' && showKpiComparison,
    staleTime: 30 * 60 * 1000,
  });

  const { data: doubledPlaybookStats } = useQuery({
    queryKey: ['playbook-stats', comparisonDays],
    queryFn: async () => {
      const response = await fetch(`/api/amplitude/playbook-stats?days=${comparisonDays}`);
      if (!response.ok) throw new Error('Failed to fetch comparison playbook stats');
      const json = await response.json();
      return json.data as PlaybookStats;
    },
    enabled: effectiveViewMode === 'kpi-tree' && showKpiComparison,
    staleTime: 30 * 60 * 1000,
  });

  // Extract deal IDs for meetings query
  const dealIds = useMemo(() => overviewDeals?.map(d => d.id) || [], [overviewDeals]);

  // Helper: fetch in batches to avoid URI Too Long (414) errors
  async function fetchInBatches<T extends Record<string, unknown>>(
    endpoint: string,
    ids: string[],
    batchSize = 100,
  ): Promise<T> {
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      batches.push(ids.slice(i, i + batchSize));
    }
    const results = await Promise.all(
      batches.map(async (batch) => {
        const response = await fetch(`${endpoint}?dealIds=${batch.join(',')}`);
        if (!response.ok) throw new Error(`Failed to fetch ${endpoint}`);
        const data = await response.json();
        return data.data as T;
      })
    );
    return Object.assign({}, ...results) as T;
  }

  // Fetch meetings separately
  const { data: meetingsData, isLoading: meetingsLoading, isFetching: meetingsFetching } = useQuery({
    queryKey: ['pipeline-meetings', selectedPipelineId, selectedProdukt, dealIds.join(',')],
    queryFn: async () => {
      if (dealIds.length === 0) return {} as DealMeetingsMap;
      const result = await fetchInBatches<DealMeetingsMap>('/api/deals/overview/meetings', dealIds);
      return result;
    },
    enabled: dealIds.length > 0,
    staleTime: 5 * 60 * 1000
  });

  // Fetch stage history separately
  const { data: stageHistoryData, isLoading: stageHistoryLoading, isFetching: stageHistoryFetching } = useQuery({
    queryKey: ['pipeline-stage-history', selectedPipelineId, selectedProdukt, dealIds.join(',')],
    queryFn: async () => {
      if (dealIds.length === 0) return {} as DealStageHistoryMap;
      const result = await fetchInBatches<DealStageHistoryMap>('/api/deals/overview/stage-history', dealIds);
      return result;
    },
    enabled: dealIds.length > 0,
    staleTime: 5 * 60 * 1000
  });

  // Merge meetings and stage history into deals
  const dealsWithMeetings: DealOverviewItem[] = useMemo(() => {
    if (!overviewDeals) return [];
    return overviewDeals.map(deal => ({
      ...deal,
      nextAppointment: meetingsData?.[deal.id] || null,
      daysInStage: stageHistoryData?.[deal.id]?.daysInStage ?? -1,
      stageEnteredAt: stageHistoryData?.[deal.id]?.stageEnteredAt ?? null,
    }));
  }, [overviewDeals, meetingsData, stageHistoryData]);

  // dealId → Einstiegs-Label laut Marketing-Flow (Agent Signup / PBX Signup /
  // Bestandskunde / Contact Form). Treibt die Prospects-Chart-Gruppierung im
  // Dashboard. Deals ohne Einstiegssignal bekommen keinen Eintrag — dort
  // greift der Lead-Source-Fallback in DashboardView.
  const dealFirstTouchpointLabel = useMemo(() => {
    const map = new Map<string, string>();
    if (!marketingData) return map;
    for (const j of marketingData.journeys) {
      if (j.kind !== 'deal') continue;
      const label = getActivationLabel(j.touchpoints, j.customerSince);
      if (label) map.set(j.entityId, label);
    }
    return map;
  }, [marketingData]);

  const leadJourneyMap = useMemo(
    () => marketingData ? buildJourneyMap(marketingData.journeys) : new Map(),
    [marketingData],
  );

  // Refresh all data: Queries invalidieren und damit aus dem Runtime-Store
  // neu lesen. Datenqualität = letzter Poller-Lauf, nicht Klick-Zeitpunkt.
  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['pipeline-overview', selectedPipelineId, selectedProdukt] });
    queryClient.invalidateQueries({ queryKey: ['pipeline-meetings', selectedPipelineId, selectedProdukt] });
    queryClient.invalidateQueries({ queryKey: ['pipeline-stage-history', selectedPipelineId, selectedProdukt] });
    queryClient.invalidateQueries({ queryKey: ['pipeline-leads', selectedProdukt] });
    queryClient.invalidateQueries({ queryKey: ['projects-overview', selectedProdukt] });
    queryClient.invalidateQueries({ queryKey: ['marketing-funnel', selectedProdukt] });
    queryClient.invalidateQueries({ queryKey: ['playbook-stats'] });
  };

  // Combined loading state for secondary data
  const secondaryDataLoading = meetingsFetching || stageHistoryFetching;

  // Show Agents Minuten column when AI Agent is selected
  const showAgentsMinuten = selectedProdukt === 'frontdesk';

  // Show the MRR ≥ 450 € System-Badge standardmäßig nur für AI Agents, weil
  // dort diese Heuristik sinnvoll ist (andere Portfolios haben andere Preise).
  const showAgentMrrBadge = selectedProdukt === 'frontdesk';

  const handleSortChange = (stageId: string, field: SortField) => {
    setSortByStage(prev => {
      const current = prev[stageId];
      let newSort: Record<string, { field: SortField; direction: SortDirection }>;

      if (current?.field === field) {
        newSort = {
          ...prev,
          [stageId]: {
            field,
            direction: current.direction === 'asc' ? 'desc' : 'asc',
          },
        };
      } else {
        newSort = {
          ...prev,
          [stageId]: {
            field,
            direction: field === 'nextAppointment' ? 'asc' : 'desc',
          },
        };
      }


      return newSort;
    });
  };

  const sortDeals = (deals: DealOverviewItem[], stageId: string): DealOverviewItem[] => {
    const sortConfig = sortByStage[stageId] || { field: 'revenue' as SortField, direction: 'desc' as SortDirection };

    return [...deals].sort((a, b) => {
      const { field, direction } = sortConfig;
      let comparison = 0;

      if (field === 'revenue') {
        comparison = a.revenue - b.revenue;
      } else if (field === 'agentsMinuten') {
        comparison = a.agentsMinuten - b.agentsMinuten;
      } else if (field === 'dealAge') {
        comparison = a.dealAge - b.dealAge;
      } else if (field === 'daysInStage') {
        // -1 bedeutet "unbekannt" (Stage-History noch nicht geladen). Solche
        // Deals ans Ende sortieren, damit sie nicht fälschlich als "am
        // längsten in Stage" oben landen.
        const aDays = a.daysInStage >= 0 ? a.daysInStage : Infinity;
        const bDays = b.daysInStage >= 0 ? b.daysInStage : Infinity;
        comparison = aDays - bDays;
      } else if (field === 'nextAppointment') {
        const aDate = a.nextAppointment?.date ? new Date(a.nextAppointment.date).getTime() : Infinity;
        const bDate = b.nextAppointment?.date ? new Date(b.nextAppointment.date).getTime() : Infinity;
        comparison = aDate - bDate;
      } else if (field === 'closedDate') {
        const aDate = a.stageEnteredAt ? new Date(a.stageEnteredAt).getTime() : (a.closedate ? new Date(a.closedate).getTime() : Infinity);
        const bDate = b.stageEnteredAt ? new Date(b.stageEnteredAt).getTime() : (b.closedate ? new Date(b.closedate).getTime() : Infinity);
        comparison = aDate - bDate;
      }

      return direction === 'asc' ? comparison : -comparison;
    });
  };

  // Reorder stages: swap "Verloren" and "Gewonnen"
  const reorderedStages = useMemo(() => {
    if (!overviewStages) return [];
    const stages = [...overviewStages];

    const verlorenIndex = stages.findIndex(s =>
      s.label.toLowerCase().includes('closed lost') || s.label.toLowerCase().includes('verloren') || s.label.toLowerCase().includes('lost')
    );
    const gewonnenIndex = stages.findIndex(s =>
      s.label.toLowerCase().includes('closed won') || s.label.toLowerCase().includes('gewonnen') || s.label.toLowerCase().includes('won')
    );

    if (verlorenIndex !== -1 && gewonnenIndex !== -1 && verlorenIndex < gewonnenIndex) {
      [stages[verlorenIndex], stages[gewonnenIndex]] = [stages[gewonnenIndex], stages[verlorenIndex]];
    }

    return stages;
  }, [overviewStages]);

  // Helper to check if stage is closed
  const isClosedStage = useCallback((label: string): boolean => {
    const closedKeywords = ['closed won', 'closed lost', 'verloren', 'lost', 'gewonnen', 'won', 'abgesagt', 'cancelled', 'storniert'];
    return closedKeywords.some(keyword => label.toLowerCase().includes(keyword));
  }, []);

  // ── Deals-/Leads-Tab Advanced-Filter ────────────────────────────────────
  // Storage-Keys (pro Pipeline+Produkt / pro Produkt). Nicht-nullable nur,
  // wenn beide Parameter gesetzt sind — sonst haben wir nichts zum Trennen.
  const dealsFiltersetsKey = selectedPipelineId && selectedProdukt
    ? `${DEALS_TAB_FILTERSETS_PREFIX}${selectedPipelineId}-${selectedProdukt}`
    : null;
  const leadsFiltersetsKey = selectedProdukt ? `${LEADS_TAB_FILTERSETS_PREFIX}${selectedProdukt}` : null;
  const dealsActiveBadgesKey = selectedPipelineId && selectedProdukt
    ? `${DEALS_TAB_ACTIVE_BADGES_PREFIX}${selectedPipelineId}-${selectedProdukt}`
    : null;
  const leadsActiveBadgesKey = selectedProdukt ? `${LEADS_TAB_ACTIVE_BADGES_PREFIX}${selectedProdukt}` : null;

  // Aktive Badges pro Tab. Default-Aktiv-Logik (für System-Badges wie
  // "MRR ≥ 450 €") wird unten beim ersten Laden via defaultActive angewendet.
  const [activeDealsBadgeIds, setActiveDealsBadgeIds] = useState<string[]>([]);
  const [activeLeadsBadgeIds, setActiveLeadsBadgeIds] = useState<string[]>([]);

  // Gespeicherte Filter-Sets aus localStorage laden, sobald der Kontext
  // (Pipeline/Produkt) steht oder sich ändert. Bewusst cascading-rerender,
  // weil die Sets an einen externen Store (localStorage) gekoppelt sind.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDealsSavedSets(dealsFiltersetsKey ? loadFilterSets<DealFieldType>(dealsFiltersetsKey) : []);
  }, [dealsFiltersetsKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLeadsSavedSets(leadsFiltersetsKey ? loadFilterSets<LeadFieldType>(leadsFiltersetsKey) : []);
  }, [leadsFiltersetsKey]);

  // Aktive Badge-IDs laden. Wenn noch keine Auswahl persistiert ist, werden
  // die `defaultActive: true`-System-Badges standardmäßig aktiv geschaltet.
  useEffect(() => {
    if (!dealsActiveBadgesKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveDealsBadgeIds([]);
      return;
    }
    const stored = loadActiveBadgeIds(dealsActiveBadgesKey);
    const defaults: string[] = [DEAL_SYSTEM_BADGE_COUNTRY_DE];
    if (selectedProdukt === 'frontdesk') defaults.push(DEAL_SYSTEM_BADGE_MIN_MRR);
    setActiveDealsBadgeIds(stored ?? defaults);
  }, [dealsActiveBadgesKey, selectedProdukt]);
  useEffect(() => {
    if (!leadsActiveBadgesKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveLeadsBadgeIds([]);
      return;
    }
    const stored = loadActiveBadgeIds(leadsActiveBadgesKey);
    setActiveLeadsBadgeIds(stored ?? [LEAD_SYSTEM_BADGE_MIN_1000, LEAD_SYSTEM_BADGE_NO_DEAL]);
  }, [leadsActiveBadgesKey]);

  const dealsFieldConfigs = useMemo(() => buildDealFieldConfigs(reorderedStages), [reorderedStages]);
  const leadsFieldConfigs = useMemo(
    () => buildLeadFieldConfigs(leadsData?.stages ?? [], leadsData?.leads ?? []),
    [leadsData?.stages, leadsData?.leads],
  );

  // System-Badges für den Deals-Tab: "Nur offene Deals" immer verfügbar,
  // "MRR ≥ 450 €" nur für AI Agents. Beide Badges sind fest im Code definiert
  // und werden als Badge (nicht als Header-Quickfilter) dargestellt.
  const dealsSystemBadges: FilterBadge<DealFieldType>[] = useMemo(() => {
    const badges: FilterBadge<DealFieldType>[] = [
      {
        id: DEAL_SYSTEM_BADGE_OPEN,
        label: 'Nur offene Deals',
        system: true,
        filter: {
          logic: 'AND',
          children: [{
            kind: 'criterion',
            id: 'sys-open',
            type: 'status',
            operator: 'after',
            dateFrom: '',
            stringValue: 'open',
          }],
        },
      },
    ];
    if (showAgentMrrBadge) {
      badges.push({
        id: DEAL_SYSTEM_BADGE_MIN_MRR,
        label: 'MRR ≥ 450 €',
        system: true,
        defaultActive: true,
        filter: {
          logic: 'AND',
          children: [{
            kind: 'criterion',
            id: 'sys-mrr',
            type: 'mrr',
            operator: 'after',
            dateFrom: '',
            numberFrom: MRR_BUCKET_THRESHOLD - 1,
          }],
        },
      });
    }
    // ICP-Tier-Badges (S1–S4). Teilen sich die `orGroup: 'icp_tier'`, damit
    // Mehrfachauswahl als OR ausgewertet wird (S1 oder S2 …). Pro Deal ist
    // genau ein Tier gesetzt; ohne orGroup würde "S1 und S2 aktiv" alles
    // ausfiltern.
    const icpBadges: Array<{ id: string; value: 'S1' | 'S2' | 'S3' | 'S4' }> = [
      { id: DEAL_SYSTEM_BADGE_ICP_S1, value: 'S1' },
      { id: DEAL_SYSTEM_BADGE_ICP_S2, value: 'S2' },
      { id: DEAL_SYSTEM_BADGE_ICP_S3, value: 'S3' },
      { id: DEAL_SYSTEM_BADGE_ICP_S4, value: 'S4' },
    ];
    for (const b of icpBadges) {
      badges.push({
        id: b.id,
        label: b.value,
        system: true,
        orGroup: 'icp_tier',
        filter: {
          logic: 'AND',
          children: [{
            kind: 'criterion',
            id: `sys-icp-${b.value}`,
            type: 'icp_tier',
            operator: 'after',
            dateFrom: '',
            stringValue: b.value,
          }],
        },
      });
    }
    // Country-Filter: System-Badge "Nur DE" filtert auf Deals ohne
    // Landesflagge im Titel. Inaktiv = alle Länder (= "Alle"). Default an,
    // weil das Cockpit primär den DACH-Sales-Blick zeigt — Auslands-Deals
    // sollen explizit per Toggle dazugeholt werden.
    badges.push({
      id: DEAL_SYSTEM_BADGE_COUNTRY_DE,
      label: 'Nur DE',
      system: true,
      defaultActive: true,
      filter: {
        logic: 'AND',
        children: [{
          kind: 'criterion',
          id: 'sys-country-de',
          type: 'country',
          operator: 'after',
          dateFrom: '',
          stringValue: 'DE',
        }],
      },
    });
    return badges;
  }, [showAgentMrrBadge]);

  // System-Badges für den Leads-Tab. Die Minuten-Badges verwenden dieselbe
  // effektive Minutenzahl wie die Anzeige: agents_minuten, falls gesetzt,
  // sonst die Untergrenze von inbound_volumen.
  const leadsSystemBadges: FilterBadge<LeadFieldType>[] = useMemo(() => {
    const minMinutenFilter = (threshold: number): FilterState<LeadFieldType> => ({
      logic: 'AND',
      children: [{
        kind: 'criterion',
        id: `sys-lead-min-${threshold}`,
        type: 'effective_minuten',
        operator: 'after',
        dateFrom: '',
        numberFrom: threshold,
      }],
    });

    return [
      {
        id: LEAD_SYSTEM_BADGE_OPEN,
        label: 'Nur offene Leads',
        system: true,
        filter: {
          logic: 'AND',
          children: [{
            kind: 'criterion',
            id: 'sys-lead-open',
            type: 'status',
            operator: 'after',
            dateFrom: '',
            stringValue: 'open',
          }],
        },
      },
      {
        id: LEAD_SYSTEM_BADGE_MIN_1000,
        label: '≥ 1000 Min.',
        system: true,
        defaultActive: true,
        filter: minMinutenFilter(1000),
      },
      {
        id: LEAD_SYSTEM_BADGE_MIN_2000,
        label: '≥ 2000 Min.',
        system: true,
        filter: minMinutenFilter(2000),
      },
      {
        id: LEAD_SYSTEM_BADGE_NO_DEAL,
        label: 'Ohne Deal',
        system: true,
        defaultActive: true,
        filter: {
          logic: 'AND',
          children: [{
            kind: 'criterion',
            id: 'sys-lead-no-deal',
            type: 'has_deal',
            operator: 'after',
            dateFrom: '',
            booleanValue: false,
          }],
        },
      },
    ];
  }, []);

  // Aktive Badges (System + gespeicherte Sets) in ausführbare Filter auflösen.
  const activeDealsBadges: FilterBadge<DealFieldType>[] = useMemo(() => {
    const system = dealsSystemBadges.filter(b => activeDealsBadgeIds.includes(b.id));
    const saved = dealsSavedSets
      .filter(s => activeDealsBadgeIds.includes(s.id))
      .map(s => ({ id: s.id, label: s.name, filter: s.filter }));
    return [...system, ...saved];
  }, [dealsSystemBadges, dealsSavedSets, activeDealsBadgeIds]);

  const activeLeadsBadges: FilterBadge<LeadFieldType>[] = useMemo(() => {
    const system = leadsSystemBadges.filter(b => activeLeadsBadgeIds.includes(b.id));
    const saved = leadsSavedSets
      .filter(s => activeLeadsBadgeIds.includes(s.id))
      .map(s => ({ id: s.id, label: s.name, filter: s.filter }));
    return [...system, ...saved];
  }, [leadsSystemBadges, leadsSavedSets, activeLeadsBadgeIds]);

  const effectiveDealsFilter = useMemo(
    () => combineFilterWithBadges<DealFieldType>(dealsFilter, activeDealsBadges),
    [dealsFilter, activeDealsBadges],
  );
  const effectiveLeadsFilter = useMemo(
    () => combineFilterWithBadges<LeadFieldType>(leadsFilter, activeLeadsBadges),
    [leadsFilter, activeLeadsBadges],
  );

  // Deep-Link-Kohorte aus der Marketing-Zeitverlauf-View: `?dealIds=a,b,c` bzw.
  // `?leadIds=a,b,c` schränken die Deals- bzw. Leads-Ansicht auf genau diese
  // HubSpot-IDs ein (die konvertierten Deals/Leads einer Wochen-/Monats-
  // Kohorte). Override — der normale FilterBuilder wird dann übersprungen,
  // damit „genau diese Einträge" gilt.
  const cohortDealIds = useMemo(() => {
    const raw = searchParams.get('dealIds');
    if (!raw) return null;
    const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
    return ids.length > 0 ? new Set(ids) : null;
  }, [searchParams]);
  const cohortLeadIds = useMemo(() => {
    const raw = searchParams.get('leadIds');
    if (!raw) return null;
    const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
    return ids.length > 0 ? new Set(ids) : null;
  }, [searchParams]);

  // Den effektiven Filterbaum (manuell + aktive Badges) auf die Deals anwenden.
  // Ausnahme: bei aktivem `dealIds`-Deep-Link genau auf die Kohorten-Deals
  // einschränken, unabhängig vom FilterBuilder.
  const dealsForDealsTab = useMemo(
    () =>
      cohortDealIds
        ? dealsWithMeetings.filter(d => cohortDealIds.has(d.id))
        : applyDealFilters(dealsWithMeetings, effectiveDealsFilter, stageHistoryData ?? {}, stageHistoryLoading),
    [cohortDealIds, dealsWithMeetings, effectiveDealsFilter, stageHistoryData, stageHistoryLoading],
  );

  // Baut Deep-Links auf die Deals-/Leads-Ansicht, gefiltert auf die übergebenen
  // IDs (behält produkt & Co. aus der aktuellen URL, räumt den jeweils anderen
  // Kohorten-Param weg). Werden an die Marketing-View durchgereicht.
  const buildDealsHref = useCallback((dealIds: string[]) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', 'deals');
    params.set('dealIds', dealIds.join(','));
    params.delete('leadIds');
    return `/?${params.toString()}`;
  }, [searchParams]);
  const buildLeadsHref = useCallback((leadIds: string[]) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', 'leads');
    params.set('leadIds', leadIds.join(','));
    params.delete('dealIds');
    return `/?${params.toString()}`;
  }, [searchParams]);

  // Hebt den jeweiligen Kohorten-Deep-Link wieder auf.
  const clearCohortDealIds = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('dealIds');
    const qs = params.toString();
    router.replace(qs ? `/?${qs}` : '/', { scroll: false });
  }, [router, searchParams]);
  const clearCohortLeadIds = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('leadIds');
    const qs = params.toString();
    router.replace(qs ? `/?${qs}` : '/', { scroll: false });
  }, [router, searchParams]);

  // Leads-Basis: rohe Liste — alle Quickfilter sind jetzt System-Badges und
  // fließen über effectiveLeadsFilter in applyLeadFilters ein.
  const leadsBase: LeadOverviewItem[] = useMemo(
    () => leadsData?.leads ?? [],
    [leadsData?.leads],
  );

  const leadsForLeadsTab = useMemo(
    () =>
      cohortLeadIds
        ? leadsBase.filter(l => cohortLeadIds.has(l.id))
        : applyLeadFilters(leadsBase, effectiveLeadsFilter),
    [cohortLeadIds, leadsBase, effectiveLeadsFilter],
  );

  // Filter-Set Handler: Deals-Tab
  const handleSaveDealsFilterSet = useCallback((name: string) => {
    if (!dealsFiltersetsKey || !name.trim()) return;
    setDealsSavedSets(prev => {
      const existing = prev.find(s => s.name === name.trim());
      const next: SavedFilterSet<DealFieldType>[] = existing
        ? prev.map(s => s.id === existing.id ? { ...s, filter: structuredClone(dealsFilter) } : s)
        : [...prev, { id: makeId(), name: name.trim(), filter: structuredClone(dealsFilter) }];
      saveFilterSets<DealFieldType>(dealsFiltersetsKey, next);
      return next;
    });
  }, [dealsFiltersetsKey, dealsFilter]);
  const handleDeleteDealsFilterSet = useCallback((id: string) => {
    if (!dealsFiltersetsKey) return;
    setDealsSavedSets(prev => {
      const next = prev.filter(s => s.id !== id);
      saveFilterSets<DealFieldType>(dealsFiltersetsKey, next);
      return next;
    });
    setActiveDealsBadgeIds(prev => {
      if (!prev.includes(id)) return prev;
      const next = prev.filter(x => x !== id);
      if (dealsActiveBadgesKey) saveActiveBadgeIds(dealsActiveBadgesKey, next);
      return next;
    });
  }, [dealsFiltersetsKey, dealsActiveBadgesKey]);
  const handleToggleDealsBadge = useCallback((id: string) => {
    setActiveDealsBadgeIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      if (dealsActiveBadgesKey) saveActiveBadgeIds(dealsActiveBadgesKey, next);
      return next;
    });
  }, [dealsActiveBadgesKey]);

  // Filter-Set Handler: Leads-Tab
  const handleSaveLeadsFilterSet = useCallback((name: string) => {
    if (!leadsFiltersetsKey || !name.trim()) return;
    setLeadsSavedSets(prev => {
      const existing = prev.find(s => s.name === name.trim());
      const next: SavedFilterSet<LeadFieldType>[] = existing
        ? prev.map(s => s.id === existing.id ? { ...s, filter: structuredClone(leadsFilter) } : s)
        : [...prev, { id: makeId(), name: name.trim(), filter: structuredClone(leadsFilter) }];
      saveFilterSets<LeadFieldType>(leadsFiltersetsKey, next);
      return next;
    });
  }, [leadsFiltersetsKey, leadsFilter]);
  const handleDeleteLeadsFilterSet = useCallback((id: string) => {
    if (!leadsFiltersetsKey) return;
    setLeadsSavedSets(prev => {
      const next = prev.filter(s => s.id !== id);
      saveFilterSets<LeadFieldType>(leadsFiltersetsKey, next);
      return next;
    });
    setActiveLeadsBadgeIds(prev => {
      if (!prev.includes(id)) return prev;
      const next = prev.filter(x => x !== id);
      if (leadsActiveBadgesKey) saveActiveBadgeIds(leadsActiveBadgesKey, next);
      return next;
    });
  }, [leadsFiltersetsKey, leadsActiveBadgesKey]);
  const handleToggleLeadsBadge = useCallback((id: string) => {
    setActiveLeadsBadgeIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      if (leadsActiveBadgesKey) saveActiveBadgeIds(leadsActiveBadgesKey, next);
      return next;
    });
  }, [leadsActiveBadgesKey]);

  // Group deals by stage
  const dealsByStage = reorderedStages.map(stage => {
    const sortedDeals = sortDeals(
      dealsForDealsTab.filter(deal => deal.dealStageId === stage.id),
      stage.id
    );
    const isClosed = isClosedStage(stage.label);
    return {
      stage,
      deals: isClosed ? sortedDeals.slice(0, 20) : sortedDeals,
      totalCount: sortedDeals.length,
    };
  }) || [];

  // Flat list for grouping="none" — globally sorted
  const flatSortedDeals = useMemo(() => {
    return [...dealsForDealsTab].sort((a, b) => {
      const { field, direction } = listSortConfig;
      let comparison = 0;

      if (field === 'revenue') {
        comparison = a.revenue - b.revenue;
      } else if (field === 'agentsMinuten') {
        comparison = a.agentsMinuten - b.agentsMinuten;
      } else if (field === 'dealAge') {
        comparison = a.dealAge - b.dealAge;
      } else if (field === 'daysInStage') {
        const aDays = a.daysInStage >= 0 ? a.daysInStage : Infinity;
        const bDays = b.daysInStage >= 0 ? b.daysInStage : Infinity;
        comparison = aDays - bDays;
      } else if (field === 'nextAppointment') {
        const aDate = a.nextAppointment?.date ? new Date(a.nextAppointment.date).getTime() : Infinity;
        const bDate = b.nextAppointment?.date ? new Date(b.nextAppointment.date).getTime() : Infinity;
        comparison = aDate - bDate;
      }

      return direction === 'asc' ? comparison : -comparison;
    });
  }, [dealsForDealsTab, listSortConfig]);

  // Handler for list view sort
  const handleListSortChange = (field: SortField) => {
    setListSortConfig(prev => {
      if (prev.field === field) {
        return { field, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { field, direction: field === 'nextAppointment' ? 'asc' : 'desc' };
    });
  };

  const currentLabel = PORTFOLIO_OPTIONS.find(o => o.value === selectedProdukt)?.label || '';

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Portfolio Selection Pills (single select, no "Alle") */}
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide mr-1">Portfolio</span>
            {PORTFOLIO_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => handleProduktChange(value)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  selectedProdukt === value
                    ? 'bg-gray-900 text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                {label}
              </button>
            ))}

            {hydrated && (overviewLoading || secondaryDataLoading) && (
              <div className="flex items-center gap-2 text-sm text-gray-500 ml-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {secondaryDataLoading && !overviewLoading ? 'Termine laden...' : 'Laden...'}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="py-6">
        {overviewError ? (
          <div className="max-w-7xl mx-auto px-4">
            <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
              <p className="text-red-700">
                Fehler beim Laden der Daten. Bitte versuchen Sie es erneut.
              </p>
            </div>
          </div>
        ) : !hydrated || overviewLoading || leadsLoading ? (
          // `!hydrated` mit reinnehmen, damit Server-Render und Initial-
          // Client-Render dasselbe HTML produzieren — sonst gibt's einen
          // Hydration-Mismatch.
          // Außerdem auf `leadsLoading` warten, damit das Dashboard nicht
          // erst mit fehlender Source-Aufteilung ("Prospects/Woche" cascade,
          // "Leads/Woche" leer) erscheint und sich Sekunden später nachfüllt.
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex items-center justify-center gap-2 text-gray-400 py-12">
              <Loader2 className="h-6 w-6 animate-spin" />
              Daten werden geladen...
            </div>
          </div>
        ) : (
          <div className="max-w-7xl mx-auto px-4 space-y-6">
            {/* Header + Tab bar */}
            <div>
              <div className="flex items-baseline justify-between mb-1">
                <h1 className="text-lg font-semibold text-gray-900">
                  {currentLabel}
                  <span className="ml-2 text-sm font-normal text-gray-400">
                    {viewMode === 'leads' ? (
                      <>
                        {(leadsData?.leads.length ?? 0)} Lead{(leadsData?.leads.length ?? 0) !== 1 ? 's' : ''}
                        {leadsLoading && (
                          <Loader2 className="h-3 w-3 animate-spin inline ml-1.5 text-blue-500" />
                        )}
                      </>
                    ) : (
                      <>
                        {dealsWithMeetings.length} Deal{dealsWithMeetings.length !== 1 ? 's' : ''}
                        {(meetingsLoading || stageHistoryLoading) && (
                          <Loader2 className="h-3 w-3 animate-spin inline ml-1.5 text-blue-500" />
                        )}
                      </>
                    )}
                  </span>
                </h1>
                <button
                  onClick={handleRefresh}
                  disabled={overviewLoading || secondaryDataLoading}
                  className="text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
                  title="Daten neu laden"
                >
                  <RefreshCw className={`h-4 w-4 ${secondaryDataLoading || overviewLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <TabBar<ViewMode>
                activeId={viewMode}
                onChange={setViewMode}
                trailing={
                  <div className="flex items-center gap-4">
                    {(viewMode === 'deals' || viewMode === 'leads') && (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() =>
                            viewMode === 'deals' ? setDealsSubView('sales') : setLeadsSubView('sales')
                          }
                          className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                            (viewMode === 'deals' ? dealsSubView : leadsSubView) === 'sales'
                              ? 'bg-gray-900 text-white'
                              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                          }`}
                        >
                          <LayoutGrid className="h-3 w-3" />
                          Sales
                        </button>
                        <button
                          onClick={() =>
                            viewMode === 'deals' ? setDealsSubView('sheet') : setLeadsSubView('sheet')
                          }
                          className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                            (viewMode === 'deals' ? dealsSubView : leadsSubView) === 'sheet'
                              ? 'bg-gray-900 text-white'
                              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                          }`}
                        >
                          <Table2 className="h-3 w-3" />
                          Sheet
                        </button>
                      </div>
                    )}
                    {((viewMode === 'deals' && dealsSubView === 'sales') ||
                      (viewMode === 'leads' && leadsSubView === 'sales')) && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-400">Gruppierung</span>
                        <button
                          onClick={() => setGrouping('stage')}
                          className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                            grouping === 'stage'
                              ? 'bg-gray-900 text-white'
                              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                          }`}
                        >
                          Nach Stage
                        </button>
                        <button
                          onClick={() => setGrouping('none')}
                          className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                            grouping === 'none'
                              ? 'bg-gray-900 text-white'
                              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                          }`}
                        >
                          Keine
                        </button>
                      </div>
                    )}
                  </div>
                }
              >
                <Tab id="dashboard" icon={BarChart3}>Dashboard</Tab>
                <Tab id="deals" icon={LayoutGrid}>Deals</Tab>
                <Tab
                  id="leads"
                  icon={Users}
                  count={leadsData ? leadsData.leads.filter(l => !l.leadStageIsClosed).length : undefined}
                >
                  Leads
                </Tab>
                {selectedProdukt === 'frontdesk' && (
                  <Tab id="projects" icon={Calendar} count={projectsData?.projects.length}>
                    Projekte
                  </Tab>
                )}
                {selectedProdukt === 'frontdesk' && (
                  <Tab id="marketing" icon={Megaphone} count={marketingData?.journeys.length}>
                    Marketing
                  </Tab>
                )}
                {selectedProdukt === 'frontdesk' && (
                  <Tab id="kpi-tree" icon={Network}>
                    KPI-Tree
                  </Tab>
                )}
              </TabBar>
            </div>

            {/* View Content */}
            {effectiveViewMode === 'dashboard' ? (
              /* Dashboard View */
              <DashboardView
                key={`${selectedPipelineId ?? 'none'}-${selectedProdukt ?? 'none'}`}
                stages={reorderedStages}
                deals={dealsWithMeetings}
                isClosedStage={isClosedStage}
                stageHistory={stageHistoryData ?? {}}
                stageHistoryLoading={stageHistoryLoading}
                pipelineId={selectedPipelineId}
                produkt={selectedProdukt}
                leads={leadsData?.leads ?? []}
                dealFirstTouchpointLabel={dealFirstTouchpointLabel}
                leadJourneyMap={leadJourneyMap}
              />
            ) : effectiveViewMode === 'projects' ? (
              /* Projekte: Wochenansicht laufender AI-Agent-Projekte */
              <ProjectsView data={projectsData} isLoading={projectsLoading} />
            ) : effectiveViewMode === 'kpi-tree' ? (
              /* KPI-Tree: AI Agents Metrik-Baum */
              <KpiTreeView
                deals={dealsWithMeetings}
                leads={leadsData?.leads ?? []}
                marketingData={marketingData}
                playbookStats={playbookStats}
                doubledMarketingData={doubledMarketingData}
                doubledPlaybookStats={doubledPlaybookStats}
                datePresetKey={marketingDatePresetKey}
                onDatePresetChange={setMarketingDatePresetKey}
              />
            ) : effectiveViewMode === 'marketing' ? (
              /* Marketing: Amplitude-Funnel + Deal-Journeys (AI Agents) */
              <MarketingView
                data={marketingData}
                isLoading={marketingLoading}
                isFetching={marketingFetching}
                datePresetKey={marketingDatePresetKey}
                onDatePresetChange={setMarketingDatePresetKey}
                buildDealsHref={buildDealsHref}
                buildLeadsHref={buildLeadsHref}
              />
            ) : effectiveViewMode === 'leads' ? (
              /* Leads-Tab: Sales- oder Sheet-Sicht */
              <>
                {cohortLeadIds ? (
                  /* Deep-Link aus der Marketing-Zeitverlauf-View: genau die
                     konvertierten Leads einer Kohorte. */
                  <div className="flex items-center justify-between gap-3 flex-wrap bg-cyan-50 border border-cyan-200 rounded-lg px-4 py-3">
                    <span className="text-sm text-cyan-900">
                      Gefiltert auf{' '}
                      <strong>{leadsForLeadsTab.length}</strong>{' '}
                      {leadsForLeadsTab.length === 1 ? 'konvertierten Lead' : 'konvertierte Leads'}
                      {' '}aus der Marketing-Kohorte
                      {cohortLeadIds.size !== leadsForLeadsTab.length && (
                        <span className="text-cyan-700">
                          {' '}({cohortLeadIds.size} angefragt, {leadsForLeadsTab.length} gefunden)
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={clearCohortLeadIds}
                      className="text-xs font-medium text-cyan-800 hover:text-cyan-950 underline underline-offset-2"
                    >
                      Filter aufheben
                    </button>
                  </div>
                ) : (
                  <FilterBuilder<LeadFieldType>
                    filter={leadsFilter}
                    onSetFilter={setLeadsFilter}
                    fieldConfigs={leadsFieldConfigs}
                    defaultType={LEAD_DEFAULT_FIELD}
                    getInputKind={getLeadInputKind}
                    totalFiltered={leadsForLeadsTab.length}
                    totalItems={leadsBase.length}
                    itemLabel="Leads"
                    savedSets={leadsSavedSets}
                    onSaveFilterSet={handleSaveLeadsFilterSet}
                    onDeleteFilterSet={handleDeleteLeadsFilterSet}
                    showFilterSets={!!leadsFiltersetsKey}
                    systemBadges={leadsSystemBadges}
                    activeBadgeIds={activeLeadsBadgeIds}
                    onToggleBadge={handleToggleLeadsBadge}
                  />
                )}
                {leadsSubView === 'sheet' ? (
                  <LeadsSpreadsheetView leads={leadsForLeadsTab} />
                ) : (
                  <LeadsSection
                    leads={leadsForLeadsTab}
                    stages={leadsData?.stages ?? []}
                    grouping={grouping}
                    loading={leadsLoading}
                  />
                )}
              </>
            ) : (
              <>
                {cohortDealIds ? (
                  /* Deep-Link aus der Marketing-Zeitverlauf-View: genau die
                     konvertierten Deals einer Kohorte. FilterBuilder wird
                     ausgeblendet, damit die Einschränkung eindeutig bleibt. */
                  <div className="flex items-center justify-between gap-3 flex-wrap bg-cyan-50 border border-cyan-200 rounded-lg px-4 py-3">
                    <span className="text-sm text-cyan-900">
                      Gefiltert auf{' '}
                      <strong>{dealsForDealsTab.length}</strong>{' '}
                      {dealsForDealsTab.length === 1 ? 'konvertierten Deal' : 'konvertierte Deals'}
                      {' '}aus der Marketing-Kohorte
                      {cohortDealIds.size !== dealsForDealsTab.length && (
                        <span className="text-cyan-700">
                          {' '}({cohortDealIds.size} angefragt, {dealsForDealsTab.length} in dieser Pipeline gefunden)
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={clearCohortDealIds}
                      className="text-xs font-medium text-cyan-800 hover:text-cyan-950 underline underline-offset-2"
                    >
                      Filter aufheben
                    </button>
                  </div>
                ) : (
                  <FilterBuilder<DealFieldType>
                    filter={dealsFilter}
                    onSetFilter={setDealsFilter}
                    fieldConfigs={dealsFieldConfigs}
                    defaultType={DEAL_DEFAULT_FIELD}
                    getInputKind={getDealInputKind}
                    totalFiltered={dealsForDealsTab.length}
                    totalItems={dealsWithMeetings.length}
                    itemLabel="Deals"
                    pendingDataLabel={stageHistoryLoading ? 'Stage-History laden...' : null}
                    pendingDataLoading={stageHistoryLoading}
                    savedSets={dealsSavedSets}
                    onSaveFilterSet={handleSaveDealsFilterSet}
                    onDeleteFilterSet={handleDeleteDealsFilterSet}
                    showFilterSets={!!dealsFiltersetsKey}
                    systemBadges={dealsSystemBadges}
                    activeBadgeIds={activeDealsBadgeIds}
                    onToggleBadge={handleToggleDealsBadge}
                  />
                )}
                {dealsSubView === 'sheet' ? (
                  /* Deals-Tab, Sheet-Sicht */
                  <SpreadsheetView deals={dealsForDealsTab} />
                ) : grouping === 'stage' ? (
                  /* Deals, grouped by stage */
                  <>
                    {dealsByStage.map(({ stage, deals, totalCount }) => (
                      <DealStageGroup
                        key={stage.id}
                        stage={stage}
                        deals={deals}
                        totalCount={totalCount}
                        pipelineId={selectedPipelineId}
                        pipelineName={overviewData?.pipelineName}
                        showAgentsMinuten={showAgentsMinuten}
                        sortConfig={sortByStage[stage.id]}
                        onSortChange={(field) => handleSortChange(stage.id, field)}
                        meetingsLoading={meetingsLoading}
                        stageHistoryLoading={stageHistoryLoading}
                      />
                    ))}
                  </>
                ) : (
                  /* Deals, flat list */
                  <DealListView
                    deals={flatSortedDeals}
                    pipelineId={selectedPipelineId}
                    onlyOpen={activeDealsBadgeIds.includes(DEAL_SYSTEM_BADGE_OPEN)}
                    sortConfig={listSortConfig}
                    onSortChange={handleListSortChange}
                    meetingsLoading={meetingsLoading}
                    stageHistoryLoading={stageHistoryLoading}
                  />
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
