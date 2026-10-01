// Runtime-Datenspeicher des Cockpits (Muster: growth-cockpit
// src/lib/runtime/store.ts): In-Memory-Snapshots je Domain, gefüllt vom
// Hintergrund-Poller (siehe poller.ts). API-Routen und der MCP-Server
// lesen hieraus synchron; View-Requests lösen nie eine Quellen-Abfrage aus.
//
// Übersteuerung im Rechner-/Pod-Neustart: Jeder Snapshot wird zusätzlich
// als JSON im temporären Verzeichnis abgelegt und beim Modul-Start wieder
// geladen — ein Kaltstart dient sofort die letzten bekannten Daten aus,
// bis der Poller frische Werte geholt hat (Best-Effort; der Speicher zählt).
//
// Anders als im Growth Cockpit hat jede Domain Varianten (produkt, days,
// pipelineId); ein Snapshot wird deshalb über (domain, variant) adressiert.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Daten-Domains des Cockpits. Die Variante pro Domain liefert der
 *  Poller (produkt / days / pipelineId); siehe *Key()-Helfer unten. */
export type Domain =
  | 'pipelines'
  | 'dealsOverview'
  | 'dealEnrichment'
  | 'leadsOverview'
  | 'projectsOverview'
  | 'marketingFunnel'
  | 'playbookStats';

export interface DomainStatus {
  /** Zeitstempel des letzten erfolgreichen Polls (ISO). */
  stand: string | null;
  /** Zeitstempel des letzten Versuchs (ISO). */
  lastAttemptAt: string | null;
  /** Letzter Fehler (inkl. cause-Kette), null wenn der letzte Poll
   *  erfolgreich war. */
  error: string | null;
}

/** Vollständige Adresse eines Snapshots: Domain + Variante. */
export type SnapshotAddress = { domain: Domain; variant: string };

interface StoreState {
  snapshots: Map<string, unknown>;
  statuses: Map<string, DomainStatus>;
}

const DOMAIN_ORDER: Domain[] = [
  'pipelines',
  'dealsOverview',
  'dealEnrichment',
  'leadsOverview',
  'projectsOverview',
  'marketingFunnel',
  'playbookStats',
];

const emptyStatus = (): DomainStatus => ({
  stand: null,
  lastAttemptAt: null,
  error: null,
});

// Singleton über HMR-/Modul-Instanzen hinweg.
const g = globalThis as { __salesCockpitStore?: StoreState };
const state: StoreState = (g.__salesCockpitStore ??= {
  snapshots: new Map(),
  statuses: new Map(),
});

const CACHE_DIR =
  process.env.SALES_COCKPIT_STORE_DIR ?? join(tmpdir(), 'sales-cockpit-store');

const fileKey = ({ domain, variant }: SnapshotAddress): string =>
  variant ? `${domain}__${variant.replace(/[^a-zA-Z0-9_-]/g, '_')}` : domain;

const cacheFile = (address: SnapshotAddress): string =>
  join(CACHE_DIR, `${fileKey(address)}.json`);

// Zuletzt persistierte Snapshots laden (Kaltstart-Bootstrap).
if (existsSync(CACHE_DIR)) {
  for (const file of readdirSafe(CACHE_DIR)) {
    try {
      const parsed = JSON.parse(readFileSync(join(CACHE_DIR, file), 'utf8')) as {
        domain: Domain;
        variant: string;
        stand: string;
        snapshot: unknown;
      };
      const address = { domain: parsed.domain, variant: parsed.variant };
      state.snapshots.set(key(address), parsed.snapshot);
      state.statuses.set(key(address), {
        stand: parsed.stand,
        lastAttemptAt: parsed.stand,
        error: null,
      });
    } catch {
      // Kaputte Cache-Datei ignorieren — der Poller füllt neu.
    }
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function key(address: SnapshotAddress): string {  return address.variant ? `${address.domain}:${address.variant}` : address.domain;
}

/** Aktuellen Snapshot oder null (noch kein Poll erfolgreich). */
export function getSnapshot<T>(address: SnapshotAddress): T | null {
  return (state.snapshots.get(key(address)) as T | undefined) ?? null;
}

/** Snapshot plus Zeitpunkt des letzten erfolgreichen Polls. */
export interface SnapshotEntry<T> {
  snapshot: T;
  stand: string | null;
}

/** Snapshot mit Stand-Zeitstempel oder null (noch kein Poll erfolgreich). */
export function getSnapshotWithStand<T>(address: SnapshotAddress): SnapshotEntry<T> | null {
  const snapshot = getSnapshot<T>(address);
  if (snapshot == null) return null;
  const status = state.statuses.get(key(address));
  return { snapshot, stand: status?.stand ?? null };
}

/** Alle Snapshots einer Domain (Adressen → Werte). Benutzt von Routen, die
 *  nur einen Deal-Subset kennen (meetings/stage-history): sie mergen über
 *  alle produkt-Varianten, statt eine konkrete Variante zu verlangen. */
export function getDomainSnapshots<T>(domain: Domain): Map<SnapshotAddress, T> {
  const out = new Map<SnapshotAddress, T>();
  for (const [k, snapshot] of state.snapshots) {
    const idx = k.indexOf(':');
    const entryDomain = idx === -1 ? k : k.slice(0, idx);
    if (entryDomain !== domain) continue;
    const variant = idx === -1 ? '' : k.slice(idx + 1);
    out.set({ domain, variant }, snapshot as T);
  }
  return out;
}

/** Snapshot setzen und als JSON persistieren. */
export function setSnapshot(address: SnapshotAddress, snapshot: unknown): void {
  state.snapshots.set(key(address), snapshot);
  const stand = new Date().toISOString();
  state.statuses.set(key(address), { stand, lastAttemptAt: stand, error: null });
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      cacheFile(address),
      JSON.stringify({
        domain: address.domain,
        variant: address.variant,
        stand,
        snapshot,
      }),
    );
  } catch {
    // Persistenz ist Best-Effort; der Speicher zählt.
  }
}

/** Snapshot-Wert zurücksetzen ohne Status-/Cache-Änderung (Rollback
 *  nach fehlgeschlagener Sanity-Prüfung). */
export function restoreSnapshot(address: SnapshotAddress, snapshot: unknown): void {
  state.snapshots.set(key(address), snapshot);
}

/** Snapshot entfernen (sanity-rollback) — persistierten Cache nicht
 *  löschen: beim nächsten Start dient er wieder als Bootstrap. */
export function clearSnapshot(address: SnapshotAddress): void {
  state.snapshots.delete(key(address));
}

/** Status aller Adressen, gruppiert nach Domain (für /health). */
export function getStatuses(): Record<Domain, Record<string, DomainStatus>> {
  const out = Object.fromEntries(DOMAIN_ORDER.map((d) => [d, {}])) as Record<
    Domain,
    Record<string, DomainStatus>
  >;
  for (const [k, status] of state.statuses) {
    const idx = k.indexOf(':');
    const domain = (idx === -1 ? k : k.slice(0, idx)) as Domain;
    const variant = idx === -1 ? '' : k.slice(idx + 1);
    if (!out[domain]) continue; // unbekannte Domain aus alten Cache-Dateien
    out[domain][variant] = status;
  }
  return out;
}

/** Status-Patch ohne Snapshot-Änderung (Fehler / Versuch eines Polls). */
/** True, wenn der Poller diese Variante überhaupt bedient (Status-Eintrag
 *  existiert) — Unterscheidung „noch kalt“ (503) vs. „nie gepollt“ (404). */
export function hasVariant(address: SnapshotAddress): boolean {
  return state.statuses.has(key(address));
}

export function setStatus(
  address: SnapshotAddress,
  patch: Partial<Omit<DomainStatus, 'stand'>>,
): void {
  const current = state.statuses.get(key(address)) ?? emptyStatus();
  state.statuses.set(key(address), { ...current, ...patch });
}

// ─── Adress-Helfer: kanonische Varianten je Domain ─────────────────────────

export const dealsKey = (pipelineId: string, produkt: string | null): SnapshotAddress => ({
  domain: 'dealsOverview',
  variant: `${pipelineId}:${produkt ?? '_all'}`,
});

export const enrichmentKey = (pipelineId: string, produkt: string | null): SnapshotAddress => ({
  domain: 'dealEnrichment',
  variant: `${pipelineId}:${produkt ?? '_all'}`,
});

export const leadsKey = (produkt: string | null): SnapshotAddress => ({
  domain: 'leadsOverview',
  variant: produkt ?? '_all',
});

export const projectsKey = (produkt: string): SnapshotAddress => ({
  domain: 'projectsOverview',
  variant: produkt,
});

export const funnelKey = (produkt: string, days: number): SnapshotAddress => ({
  domain: 'marketingFunnel',
  variant: `${produkt}:${days}`,
});

export const playbookKey = (days: number): SnapshotAddress => ({
  domain: 'playbookStats',
  variant: String(days),
});

export const pipelinesKey: SnapshotAddress = { domain: 'pipelines', variant: '' };
