// Projects-Overview-Builder (aus src/app/api/projects/overview/route.ts
// extrahiert). Phase 1 ist AI-Agents-only (produkt='frontdesk').

import { getHubSpotClient } from '@/lib/hubspot/client';
import { getJiraClient } from '@/lib/jira/client';
import { extractJiraIssueKey } from '@/lib/jira/parse';
import { isWonStageLabel, isLostStageLabel } from '@/lib/hubspot/mrr';
import { SALES_PIPELINE_ID } from '@/lib/constants';

// Length of a project in days. The project is anchored to its end date
// (JIRA "Ende der Testphase") and runs for 4 weeks before that — so
// `start = end - 27 days` (inclusive on both ends → 28 calendar days).
const PROJECT_LENGTH_DAYS = 28;

// Woher kommt das Datum eines Projekt-Balkens?
// - jira-test-phase: JIRA-Custom-Field "Ende der Testphase" ist gesetzt — der
//   verbindliche Fall.
// - deal-won-fallback: JIRA-Feld leer, aber der HubSpot-Deal ist gewonnen,
//   also leiten wir den 4-Wochen-Block aus dem Won-Datum ab. Das ist eine
//   Annahme, die im Frontend schraffiert dargestellt wird, damit klar ist:
//   im JIRA fehlt das Datum.
// - negotiation-projected: Deal ist in Commercial Negotiation, der PoC ist
//   noch nicht angefangen. Wir projizieren auf "heute + 4 Wochen", als ob
//   der Deal heute gewonnen würde — damit man potenzielle Projekte sieht.
//   Im Frontend grau dargestellt; standardmäßig versteckt hinter dem
//   "Gewonnen/Offene Deals"-Filter.
export type ProjectDateSource = 'jira-test-phase' | 'deal-won-fallback' | 'negotiation-projected';

export interface ProjectOverviewItem {
  dealId: string;
  dealName: string;
  hubspotUrl: string;
  companyName: string;
  jiraKey: string;
  jiraUrl: string;
  jiraSummary: string;
  jiraStatus: string;
  jiraIssueType: string;
  // Geplantes Ende der Testphase (ISO `YYYY-MM-DD`, end inclusive). Bei
  // `dateSource='jira-test-phase'` aus JIRA `customfield_11758`, sonst
  // abgeleitet aus dem Won-Datum + 27d. Der grüne Balken endet hier.
  endDate: string;
  startDate: string;
  // Tatsächliches Ende, wenn das JIRA-Issue resolved ist (Status
  // "Abgeschlossen" / "Kunde verloren" → JIRA setzt `resolutiondate`).
  // Wenn gesetzt, läuft der Balken nur bis hierher und ist grau (Projekt
  // beendet). null, solange das Projekt offen ist.
  actualEndDate: string | null;
  dateSource: ProjectDateSource;
  // HubSpot-Deal-Stage Label (z.B. "Closed lost", "Closed won",
  // "In Implementation"). Wird im Frontend für die Filter-Badge
  // "Gewonnen/Offene Deals" benutzt.
  dealStage: string;
  // Convenience flag: ist der HubSpot-Deal Closed Lost?
  dealIsLost: boolean;
  // Convenience flag: ist das JIRA-Issue abgeschlossen oder Kunde verloren?
  // Im Code identisch zur Frontend-`isCompleted`-Logik, aber serverseitig
  // berechnet, damit die Filter konsistent zählen.
  projectIsClosed: boolean;
  // Aggregierte Sub-Task-Counts (alle direkten Children des Customer-Journey-
  // Issues). Frontend rendert die als Punkte zwischen Firmenname und JIRA-Link.
  childTasks: {
    open: number;
    done: number;
  };
}

export interface ProjectsOverviewResponse {
  projects: ProjectOverviewItem[];
  // Issues we found a HubSpot deal for, but neither JIRA nor the deal won-date
  // gave us a usable anchor. Useful for the UI to surface "X Deals haben kein
  // Datum, das wir verwenden können".
  unscheduledCount: number;
}

function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export async function buildProjectsOverview(produkt: string): Promise<ProjectsOverviewResponse> {
    const hubspot = getHubSpotClient();

    // Pipeline-Stages für den Won-Stage-Lookup (Fallback, wenn JIRA kein
    // "Ende der Testphase" hat — dann nutzen wir das Deal-Won-Datum).
    const pipelines = await hubspot.getPipelines();
    const pipeline = pipelines.results.find((p) => p.id === SALES_PIPELINE_ID);
    const stageLabelById = new Map<string, string>();
    for (const stage of pipeline?.stages ?? []) {
      stageLabelById.set(stage.id, stage.label);
    }

    const dealsWithAssociations = await hubspot.getDealsWithAssociations(
      SALES_PIPELINE_ID,
      produkt,
    );

    type DealRow = (typeof dealsWithAssociations.results)[number];

    function isNegotiationStage(label: string): boolean {
      return label.toLowerCase().includes('negotiation');
    }

    // Deals mit jira_story brauchen wir für den JIRA-Fetch.
    const dealsWithJira = dealsWithAssociations.results
      .map((deal) => ({
        deal,
        jiraKey: extractJiraIssueKey(deal.properties.jira_story ?? null),
      }))
      .filter((entry): entry is { deal: DealRow; jiraKey: string } => !!entry.jiraKey);

    // Negotiation-Deals zeigen wir zusätzlich als "potenzielle Projekte" an —
    // auch wenn sie keine `jira_story` verlinkt haben.
    const dealsInNegotiation = dealsWithAssociations.results.filter((d) =>
      isNegotiationStage(stageLabelById.get(d.properties.dealstage ?? '') ?? ''),
    );

    if (dealsWithJira.length === 0 && dealsInNegotiation.length === 0) {
      return { projects: [], unscheduledCount: 0 };
    }

    // Resolve company names. Same pattern as /api/deals/overview, but kept
    // intentionally simpler (no sipgate-account-mastersipid fallback) — the
    // Projekte tab only shows already-active projects, so the noisier company
    // disambiguation logic isn't needed.
    const companyIds = new Set<string>();
    const collectCompany = (deal: DealRow) => {
      const companyAssoc = deal.associations?.companies?.results?.[0];
      if (companyAssoc) companyIds.add(companyAssoc.id);
    };
    for (const { deal } of dealsWithJira) collectCompany(deal);
    for (const deal of dealsInNegotiation) collectCompany(deal);

    const companiesMap = new Map<string, { name: string }>();
    if (companyIds.size > 0) {
      const companies = await hubspot.getCompanies(Array.from(companyIds));
      for (const company of companies.results) {
        companiesMap.set(company.id, { name: company.properties.name || 'Unknown' });
      }
    }

    // Fetch all linked JIRA issues in one batch, plus their direct children
    // (Sub-Tasks). Children kommen aus zwei Quellen:
    //  - Klassisches `parent`-Field (JQL `parent in (...)`).
    //  - Issue-Links vom Typ „Parent" (im SC-Projekt der dominante Weg).
    // Beide Quellen werden gemerged.
    const jiraClient = getJiraClient();
    const issueKeys = dealsWithJira.map((e) => e.jiraKey);
    const [issues, childrenViaParentField] = await Promise.all([
      jiraClient.getIssuesByKeys(issueKeys),
      jiraClient.getChildrenForParents(issueKeys),
    ]);
    const issuesByKey = new Map(issues.map((issue) => [issue.key, issue]));

    // Issue-Link-Children: aus dem geladenen Parent-Issue selbst (linkedChildKeys)
    // ergeben sich die child-keys. Diese laden wir gesammelt nach und mappen sie
    // zurück auf den jeweiligen Parent.
    const linkChildKeyToParent = new Map<string, string>();
    for (const parent of issues) {
      for (const childKey of parent.linkedChildKeys) {
        // Erst-Eintrag gewinnt, falls ein Kind doppelt referenziert wäre.
        if (!linkChildKeyToParent.has(childKey)) {
          linkChildKeyToParent.set(childKey, parent.key);
        }
      }
    }
    const allLinkChildKeys = Array.from(linkChildKeyToParent.keys());
    const linkChildIssues = allLinkChildKeys.length > 0
      ? await jiraClient.getIssuesByKeys(allLinkChildKeys)
      : [];

    // Final: parent-key → JiraIssue[] (deduped per child-key, beide Quellen)
    const childrenByParent = new Map<string, typeof linkChildIssues>();
    for (const [parentKey, children] of childrenViaParentField.entries()) {
      childrenByParent.set(parentKey, [...children]);
    }
    for (const child of linkChildIssues) {
      const parentKey = linkChildKeyToParent.get(child.key);
      if (!parentKey) continue;
      const list = childrenByParent.get(parentKey) ?? [];
      if (!list.some((c) => c.key === child.key)) {
        list.push(child);
      }
      childrenByParent.set(parentKey, list);
    }

    const projects: ProjectOverviewItem[] = [];
    let unscheduledCount = 0;

    const todayIso = new Date().toISOString().slice(0, 10);

    // Helper: baut ein ProjectOverviewItem aus einem Deal + optional Issue +
    // dem ausgehandelten Datumspaar/dateSource. JIRA-spezifische Felder sind
    // leer, wenn kein Issue (negotiation ohne jira_story).
    function buildItem(
      deal: DealRow,
      issue: typeof issues[number] | null,
      startDate: string,
      endDate: string,
      dateSource: ProjectDateSource,
    ): ProjectOverviewItem {
      const companyId = deal.associations?.companies?.results?.[0]?.id;
      const companyName =
        (companyId ? companiesMap.get(companyId)?.name : undefined) ||
        deal.properties.dealname ||
        'Unknown';
      const dealStageLabel = stageLabelById.get(deal.properties.dealstage ?? '') ?? '';
      const dealIsLost = isLostStageLabel(dealStageLabel);
      const actualEndDate = issue?.resolutionDate ? issue.resolutionDate.slice(0, 10) : null;

      const jiraStatusLower = issue?.status.name.toLowerCase() ?? '';
      const projectIsClosed = !!issue && (
        !!issue.resolutionDate ||
        jiraStatusLower.includes('fertig') ||
        jiraStatusLower.includes('done') ||
        jiraStatusLower.includes('closed') ||
        jiraStatusLower.includes('abgeschlossen') ||
        jiraStatusLower.includes('kunde verloren')
      );

      let childOpen = 0;
      let childDone = 0;
      if (issue) {
        const childIssues = childrenByParent.get(issue.key) ?? [];
        for (const c of childIssues) {
          const done = c.resolutionDate || c.status.statusCategory?.key === 'done';
          if (done) childDone += 1;
          else childOpen += 1;
        }
      }

      return {
        dealId: deal.id,
        dealName: deal.properties.dealname || 'Unknown',
        hubspotUrl: `https://app.hubspot.com/contacts/27058496/record/0-3/${deal.id}`,
        companyName,
        jiraKey: issue?.key ?? '',
        jiraUrl: issue?.url ?? '',
        jiraSummary: issue?.summary ?? '',
        jiraStatus: issue?.status.name ?? '',
        jiraIssueType: issue?.issueType.name ?? '',
        endDate,
        startDate,
        actualEndDate,
        dateSource,
        dealStage: dealStageLabel,
        dealIsLost,
        projectIsClosed,
        childTasks: { open: childOpen, done: childDone },
      };
    }

    // Dedupe: ein Deal soll nur ein Item pro Aufruf produzieren. Wenn er in
    // Negotiation ist UND eine jira_story hat, gewinnt der jira_story-Pfad
    // (testPhaseEnd oder Won-Fallback). Erst wenn weder testPhaseEnd noch Won-
    // Fallback greifen, fällt der Deal in den negotiation-projected-Pfad.
    const emittedDealIds = new Set<string>();

    // Pfad 1: Deals mit jira_story
    for (const { deal, jiraKey } of dealsWithJira) {
      const issue = issuesByKey.get(jiraKey);
      const stageLabel = stageLabelById.get(deal.properties.dealstage ?? '') ?? '';
      const isWon = isWonStageLabel(stageLabel);
      const isNegotiation = isNegotiationStage(stageLabel);

      if (!issue) {
        // Linked issue missing or inaccessible — count, aber den Deal nicht verlieren,
        // falls er in Negotiation ist: dann fließt er gleich in den Negotiation-Pfad.
        if (!isNegotiation) unscheduledCount += 1;
        continue;
      }

      if (issue.testPhaseEnd) {
        const endDate = issue.testPhaseEnd;
        const startDate = shiftIsoDate(endDate, -(PROJECT_LENGTH_DAYS - 1));
        projects.push(buildItem(deal, issue, startDate, endDate, 'jira-test-phase'));
        emittedDealIds.add(deal.id);
        continue;
      }

      const closedateRaw = deal.properties.closedate;
      if (isWon && closedateRaw) {
        const closeDay = closedateRaw.slice(0, 10);
        projects.push(
          buildItem(deal, issue, closeDay, shiftIsoDate(closeDay, PROJECT_LENGTH_DAYS - 1), 'deal-won-fallback'),
        );
        emittedDealIds.add(deal.id);
        continue;
      }

      if (isNegotiation) {
        // Negotiation mit jira_story aber ohne nutzbares Datum → projected.
        // Issue trotzdem mitgeben, damit Sub-Task-Counts und Link funktionieren.
        projects.push(
          buildItem(deal, issue, todayIso, shiftIsoDate(todayIso, PROJECT_LENGTH_DAYS - 1), 'negotiation-projected'),
        );
        emittedDealIds.add(deal.id);
        continue;
      }

      // Hat jira_story aber kein nutzbares Datum + nicht in Negotiation → unscheduled.
      unscheduledCount += 1;
    }

    // Pfad 2: Negotiation-Deals ohne jira_story (oder die in Pfad 1 nicht
    // emittet wurden — z.B. weil das verlinkte Issue nicht zugreifbar war).
    for (const deal of dealsInNegotiation) {
      if (emittedDealIds.has(deal.id)) continue;
      projects.push(
        buildItem(deal, null, todayIso, shiftIsoDate(todayIso, PROJECT_LENGTH_DAYS - 1), 'negotiation-projected'),
      );
    }

    // Sort by start date so the UI gets a stable, chronologically meaningful order.
    projects.sort((a, b) => a.startDate.localeCompare(b.startDate));

    return { projects, unscheduledCount };
}
