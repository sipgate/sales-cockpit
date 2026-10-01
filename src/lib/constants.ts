// Geteilte Konstanten des Cockpits. Bisher waren diese Werte pro Datei
// dupliziert (page.tsx, mcp/data.ts, projects/route.ts) — Single Source of
// Truth ab jetzt hier.

/** "Sales sipgate Portfolio" pipeline in hub 27058496. */
export const SALES_PIPELINE_ID = '3576006860';

/** Portfolio-Schlüssel des AI-Agents-Produkts (Produktfilter-Wert in der
 *  HubSpot-Property `angebotene_produkte` / URL-Parameter `produkt`). */
export const AI_AGENTS_PRODUKT = 'frontdesk';

/** Alle Produktfilter, die das Cockpit-UI anbietet. Der Poller baut je
 *  Wert einen eigenen Deals-/Leads-Snapshot. Reihenfolge = UI-Reihenfolge. */
export const PORTFOLIO_OPTIONS = [
  { value: 'neo', label: 'Cloud PBX' },
  { value: 'frontdesk', label: 'AI Agents' },
  { value: 'flow', label: 'AI Flow' },
  { value: 'cx', label: 'Contact Center' },
  { value: 'trunking', label: 'Trunking' },
  { value: 'easy', label: 'satellite Business' },
] as const;

export type PortfolioValue = (typeof PORTFOLIO_OPTIONS)[number]['value'];
