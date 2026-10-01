// Pipeline-Overview-Builder (aus src/app/api/deals/overview/route.ts
// extrahiert, damit der Runtime-Poller ihn ohne next/server-Imports nutzen
// kann — Muster growth-cockpit: Builder-Layer frei von Next-Abhängigkeiten).

import { getHubSpotClient, PRODUCT_LINE_ITEM_CATEGORY } from '@/lib/hubspot/client';
import {
  AmplitudeAttribution,
  getAiAgentsAttributionByEmail,
} from '@/lib/amplitude/attribution';

export class PipelineNotFoundError extends Error {
  constructor(public pipelineId: string) {
    super(`Pipeline ${pipelineId} not found`);
    this.name = 'PipelineNotFoundError';
  }
}

// How `revenue` (MRR) was derived. Shown in the spreadsheet view so the user
// can see whether the MRR came from an actual line-item `hs_mrr`, from the
// AI-Agent package price (computed from qualified minutes), from the legacy
// TCV / Vertragsdauer fallback, or could not be computed at all.
export type RevenueSource = 'line_items' | 'agents_package' | 'tcv_laufzeit' | 'none';

// HubSpot-Property `icp_tier` — enum mit Werten S1 / S2 / S3 / S4. Nicht
// jeder Deal hat den Wert gesetzt (null = unklassifiziert).
export type IcpTier = 'S1' | 'S2' | 'S3' | 'S4';

export interface DealOverviewItem {
  id: string;
  companyName: string;
  dealName: string;
  revenue: number;
  revenueSource: RevenueSource;
  agentsMinuten: number;
  productManager: string;
  angeboteneProdukte: string;
  icpTier: IcpTier | null;
  dealStage: string;
  dealStageId: string;
  dealAge: number; // Alter des Deals in Tagen
  daysInStage: number; // Tage in aktueller Stage
  stageEnteredAt: string | null; // Datum, an dem der Deal in die aktuelle Stage verschoben wurde
  createdate: string | null; // Datum, an dem der Deal erstellt wurde
  closedate: string | null; // Datum, an dem der Deal geschlossen wurde
  nextAppointment: {
    date: string;
    title: string;
  } | null;
  // Amplitude-Attribution: das früheste AI-Agents-flavoured Event über alle
  // verknüpften Kontakte des Deals (Email-Match gegen Amplitude `user_id`).
  // Phase 1 nur für `?produkt=frontdesk`. null wenn kein Match oder anderer
  // Produkt-Filter aktiv ist.
  amplitudeSource: AmplitudeAttribution | null;
}

export interface PipelineOverviewResponse {
  pipelineId: string;
  pipelineName: string;
  stages: Array<{
    id: string;
    label: string;
    displayOrder: number;
    probability: number;
  }>;
  deals: DealOverviewItem[];
}

export function isLostStage(label: string): boolean {
  const l = label.toLowerCase();
  if (l.includes('closed lost')) return true;
  return l.includes('verloren') || l.includes('lost') || l.includes('abgesagt') || l.includes('cancelled') || l.includes('storniert');
}

export function isWonStage(label: string): boolean {
  if (isLostStage(label)) return false;
  const l = label.toLowerCase();
  if (l.includes('closed won')) return true;
  return l.includes('gewonnen') || l.includes('won') || l.includes('abgeschlossen') || l.includes('aktiv') || l.includes('active');
}

export async function buildPipelineOverview(
  pipelineId: string,
  produkt: string | null,
): Promise<PipelineOverviewResponse> {
    const client = getHubSpotClient();

    // Fetch pipeline info
    const pipelines = await client.getPipelines();
    const pipeline = pipelines.results.find(p => p.id === pipelineId);

    if (!pipeline) {
      throw new PipelineNotFoundError(pipelineId);
    }

    // Fetch deals with associations (filtered by product if specified)
    const dealsWithAssociations = await client.getDealsWithAssociations(pipelineId, produkt || undefined);

    // For deals with line items, fetch the HubSpot product `category` so we can
    // verify the actual product mix. Line items are the source of truth;
    // `angebotene_produkte` may be stale. Using `category` is robust against
    // SKU renames (e.g. "AI Agent – Enterprise ab 2.500 Min" → "Enterprise ab 2.500 Min").
    const dealsWithLineItems = dealsWithAssociations.results.filter(
      d => (parseInt(d.properties.hs_num_of_associated_line_items) || 0) > 0
    );
    const lineItemCategoriesByDeal = await client.getLineItemCategoriesForDeals(
      dealsWithLineItems.map(d => d.id)
    );

    // Filter: if product filter is active, drop deals that have line items but none
    // of them match the selected product. Mapping from portfolio key → category value
    // lives in the HubSpot client (shared with the union-fetch in getDealsWithAssociations).
    const requiredCategory = produkt ? PRODUCT_LINE_ITEM_CATEGORY[produkt] : undefined;
    const filteredDeals = requiredCategory
      ? dealsWithAssociations.results.filter(deal => {
          const categories = lineItemCategoriesByDeal.get(deal.id);
          if (!categories) return true; // no line items → keep (legacy field was enough)
          return categories.some(cat => cat === requiredCategory);
        })
      : dealsWithAssociations.results;

    // Collect all company IDs
    const companyIds = new Set<string>();
    for (const deal of filteredDeals) {
      const companyAssoc = deal.associations?.companies?.results?.[0];
      if (companyAssoc) {
        companyIds.add(companyAssoc.id);
      }
    }

    // Collect all contact IDs (für sipgate-Account-Fallback: Kontakt mit gesetztem
    // `mastersipid` zählt als verknüpfter sipgate-Account und liefert den Firmennamen).
    const contactIds = new Set<string>();
    for (const deal of filteredDeals) {
      for (const contactAssoc of deal.associations?.contacts?.results ?? []) {
        contactIds.add(contactAssoc.id);
      }
    }

    // Batch fetch companies
    const companiesMap = new Map<string, { name: string }>();
    if (companyIds.size > 0) {
      const companies = await client.getCompanies(Array.from(companyIds));
      for (const company of companies.results) {
        companiesMap.set(company.id, {
          name: company.properties.name || 'Unknown',
        });
      }
    }

    // Batch fetch contacts mit company + mastersipid für sipgate-Account-Fallback.
    // Bei AI-Agents-View (produkt=frontdesk) ziehen wir zusätzlich `email`, um
    // die Amplitude-Attribution per Email zu joinen.
    const wantAmplitude = produkt === 'frontdesk';
    const contactProps = wantAmplitude
      ? ['company', 'mastersipid', 'email']
      : ['company', 'mastersipid'];
    const contactsMap = new Map<string, { company: string; mastersipid: string; email: string }>();
    if (contactIds.size > 0) {
      const contacts = await client.getContacts(Array.from(contactIds), contactProps);
      for (const contact of contacts.results) {
        contactsMap.set(contact.id, {
          company: contact.properties.company || '',
          mastersipid: contact.properties.mastersipid || '',
          email: contact.properties.email || '',
        });
      }
    }

    // Amplitude-Attribution: einen einzigen BQ-Query für alle Kontakte aller
    // gefilterten Deals. Fail-safe — bricht BQ (Creds, IAM, Netz), liefern wir
    // leere Map und die View funktioniert weiter ohne Amplitude-Badge.
    const amplitudeByEmail = await (async (): Promise<Map<string, AmplitudeAttribution>> => {
      if (!wantAmplitude) return new Map();
      const emails = Array.from(contactsMap.values())
        .map(c => c.email)
        .filter((e): e is string => !!e);
      if (emails.length === 0) return new Map();
      try {
        return await getAiAgentsAttributionByEmail(emails);
      } catch (err) {
        console.error('[deals/overview] amplitude attribution lookup failed:', err);
        return new Map();
      }
    })();

    // Helper to calculate deal age in days
    const calculateDealAge = (createdate: string | undefined): number => {
      if (!createdate) return 0;
      const created = new Date(createdate);
      const now = new Date();
      const diffTime = now.getTime() - created.getTime();
      return Math.floor(diffTime / (1000 * 60 * 60 * 24));
    };

    // Calculate AI Agent MRR from agent minutes using package pricing
    // Each package has included minutes + a per-minute rate for overage
    // Pick the cheapest package for the given minute volume
    function calculateAgentMrr(minutes: number): number {
      if (minutes <= 0) return 0;

      const packages = [
        { included: 300, price: 74.95, perMinute: 0.25 },
        { included: 1000, price: 199.95, perMinute: 0.20 },
        { included: 2500, price: 449.95, perMinute: 0.18 },
        { included: 10000, price: 1499.95, perMinute: 0.15 },
      ];

      return Math.min(
        ...packages.map(pkg =>
          pkg.price + Math.max(0, minutes - pkg.included) * pkg.perMinute
        )
      );
    }

    // Build the overview items (without meetings - those are loaded separately)
    const deals: DealOverviewItem[] = filteredDeals.map((deal) => {
      const companyId = deal.associations?.companies?.results?.[0]?.id;
      const company = companyId ? companiesMap.get(companyId) : undefined;
      const stage = pipeline.stages.find(s => s.id === deal.properties.dealstage);
      const dealStage = stage?.label || deal.properties.dealstage || 'Unknown';
      const isWonDeal = isWonStage(dealStage);

      // sipgate-Account-Fallback: erster verknüpfter Contact mit gesetztem
      // `mastersipid` gilt als verknüpfter sipgate-Account. Dessen `company`-Feld
      // hat Vorrang vor der assoziierten Company — sipgate-Accounts sind in der
      // Praxis näher an der tatsächlich kaufenden Firma als die HubSpot-Company.
      // Zweiter Fallback: `company`-Feld eines beliebigen verknüpften Kontakts
      // (ohne mastersipid-Anforderung), damit Deals ohne assoziierte Company
      // trotzdem einen Firmennamen bekommen statt auf den Dealnamen zu fallen.
      const { sipgateAccountCompany, contactCompanyFallback } = (() => {
        let sipgate = '';
        let anyContact = '';
        for (const contactAssoc of deal.associations?.contacts?.results ?? []) {
          const contact = contactsMap.get(contactAssoc.id);
          if (!contact?.company) continue;
          if (contact.mastersipid && !sipgate) {
            sipgate = contact.company;
          }
          if (!anyContact) {
            anyContact = contact.company;
          }
          if (sipgate) break; // sipgate hat Vorrang, sobald gefunden aufhören
        }
        return { sipgateAccountCompany: sipgate, contactCompanyFallback: anyContact };
      })();

      // Prefer qualified minutes, fall back to old field
      const agentMinuten = parseInt(deal.properties.agents_minuten_qualifiziert) || parseInt(deal.properties.agents_minuten) || 0;

      // We compute MRR from whichever signal is available — line items
      // (hs_mrr) and agent minutes can each be incomplete for a given deal:
      //  - hs_mrr is 0 if the line items aren't marked recurring or the
      //    property is simply unset
      //  - agents_minuten_qualifiziert is 0 if the deal predates that
      //    qualification step
      // For open AI Agent deals we take the max of both (either signal is
      // better than dropping the deal to 0). Once a deal is won, the accepted
      // offer wins: if there is a line-item MRR, we use that instead of a
      // higher calculated package price. For non-AI-Agent deals we fall back
      // to TCV/Laufzeit only when there's no line-item MRR.
      const { revenue, revenueSource } = ((): { revenue: number; revenueSource: RevenueSource } => {
        const products = deal.properties.angebotene_produkte || '';
        const isAiAgent = products.split(';').includes('frontdesk');
        const lineItemCount = parseInt(deal.properties.hs_num_of_associated_line_items) || 0;
        const lineItemMrr = lineItemCount > 0 ? (parseFloat(deal.properties.hs_mrr) || 0) : 0;

        if (isAiAgent) {
          if (isWonDeal && lineItemMrr > 0) {
            return { revenue: lineItemMrr, revenueSource: 'line_items' };
          }

          const packageMrr = calculateAgentMrr(agentMinuten);
          if (packageMrr > lineItemMrr) {
            return { revenue: packageMrr, revenueSource: 'agents_package' };
          }
          if (lineItemMrr > 0) {
            return { revenue: lineItemMrr, revenueSource: 'line_items' };
          }
          return { revenue: 0, revenueSource: 'none' };
        }

        if (lineItemMrr > 0) return { revenue: lineItemMrr, revenueSource: 'line_items' };

        const tcv = parseFloat(deal.properties.tcv) || 0;
        const laufzeit = parseFloat(deal.properties.vertragsdauer) || 0;
        if (laufzeit > 0) return { revenue: tcv / laufzeit, revenueSource: 'tcv_laufzeit' };

        return { revenue: 0, revenueSource: 'none' };
      })();

      // icp_tier aus HubSpot ist ein freier String ('S1'|'S2'|'S3'|'S4'|'').
      // Wir engen auf den IcpTier-Union ein und null-fallback, damit die UI
      // nicht an unerwarteten Werten rät.
      const rawIcp = deal.properties.icp_tier || '';
      const icpTier: IcpTier | null =
        rawIcp === 'S1' || rawIcp === 'S2' || rawIcp === 'S3' || rawIcp === 'S4' ? rawIcp : null;

      // Earliest Amplitude-Attribution über alle Kontakte des Deals. Ein Deal
      // kann mehrere Kontakte haben (Käufer, Tech-Lead, Admin …); wir zeigen
      // den frühesten Touchpoint irgendeines davon.
      const amplitudeSource = ((): AmplitudeAttribution | null => {
        let best: AmplitudeAttribution | null = null;
        for (const contactAssoc of deal.associations?.contacts?.results ?? []) {
          const contact = contactsMap.get(contactAssoc.id);
          if (!contact?.email) continue;
          const attr = amplitudeByEmail.get(contact.email.toLowerCase());
          if (!attr) continue;
          if (!best || attr.occurredAt < best.occurredAt) {
            best = attr;
          }
        }
        return best;
      })();

      return {
        id: deal.id,
        companyName: sipgateAccountCompany || company?.name || contactCompanyFallback || '',
        dealName: deal.properties.dealname || '',
        revenue,
        revenueSource,
        agentsMinuten: agentMinuten,
        productManager: deal.properties.deal_po || '',
        angeboteneProdukte: deal.properties.angebotene_produkte || '',
        icpTier,
        dealStage,
        dealStageId: deal.properties.dealstage || '',
        dealAge: calculateDealAge(deal.properties.createdate),
        daysInStage: -1, // Loaded separately via /api/deals/overview/stage-history
        stageEnteredAt: null, // Loaded separately via /api/deals/overview/stage-history
        createdate: deal.properties.createdate || null,
        closedate: deal.properties.closedate || null,
        nextAppointment: null, // Loaded separately via /api/deals/overview/meetings
        amplitudeSource,
      };
    });

    const response: PipelineOverviewResponse = {
      pipelineId: pipeline.id,
      pipelineName: pipeline.label,
      stages: pipeline.stages.map((stage, index) => ({
        id: stage.id,
        label: stage.label,
        displayOrder: index,
        probability: parseFloat(stage.metadata?.probability || '0'),
      })),
      deals,
    };

    return response;
}
