// BigQuery-Zugriff für den Runtime-Poller (und die verbleibenden
// interaktiven Routen): REST-Jobs-API mit Service-Account-JWT statt des
// @google-cloud/bigquery-SDKs. Grund: Der SDK nutzt gRPC, und gRPC
// ignoriert die http_proxy/https_proxy-Env-Variablen, die Nautilus den
// Service-Pods injiziert — im Tooling-Cluster käme jede Query am Squid-
// Egress-Proxy vorbei und würde still scheitern. Die REST-API läuft über
// fetch (undici), den der EnvHttpProxyAgent sauber durch den Proxy schickt
// (siehe src/lib/sources/proxy.ts). Muster: growth-cockpit
// src/lib/sources/bq.ts.
//
// Kosten-Leitplanken bleiben unverändert:
//  - jede Query zuerst als Dry-Run; erwartete Bytes über dem Cap → Abbruch
//  - `maximumBytesBilled` (Default 300 GiB) als Hard-Limit seitens BigQuery
//  - Query-Rate nur aus dem Poll-Timer, nie aus View-Requests
//
// Zugangsdaten, in dieser Reihenfolge:
//   1. GOOGLE_APPLICATION_CREDENTIALS_JSON (Key als Inline-JSON, nautilus-Secret)
//   2. GOOGLE_APPLICATION_CREDENTIALS (Pfad zur Key-Datei)

import { existsSync, readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const PROJECT_ID = 'ff-amplitude';

export class BigQueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`BigQuery query timed out after ${timeoutMs}ms`);
    this.name = 'BigQueryTimeoutError';
  }
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** Service-Account-Key aus Env (inline JSON oder Datei-Pfad). Wirft ohne
 *  Key — der Poller fängt das und deaktiviert die BigQuery-Polls. */
export function serviceAccountKey(): ServiceAccountKey {
  const inline = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (inline) return JSON.parse(inline) as ServiceAccountKey;
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path) {
    if (!existsSync(path)) {
      throw new Error(`GOOGLE_APPLICATION_CREDENTIALS: Datei ${path} fehlt.`);
    }
    return JSON.parse(readFileSync(path, 'utf8')) as ServiceAccountKey;
  }
  throw new Error(
    'Kein Service-Account-Key für BigQuery: GOOGLE_APPLICATION_CREDENTIALS_JSON ' +
      'oder GOOGLE_APPLICATION_CREDENTIALS setzen.',
  );
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Access-Token (JWT-Flow, bigquery.readonly); gecacht bis fast abgelaufen. */
export async function bqAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const key = serviceAccountKey();
  const b64url = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const claim = b64url({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const assertion = `${header}.${claim}.${signer
    .sign(key.private_key)
    .toString('base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`BigQuery-Token-Endpunkt: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return body.access_token;
}

async function bq(
  path: string,
  { method = 'GET', body }: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const token = await bqAccessToken();
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: { message?: string } })
    | null;
  if (!res.ok) {
    throw new Error(
      `BigQuery ${path}: ${data?.error?.message ?? `HTTP ${res.status}`}`,
    );
  }
  return data as Record<string, unknown>;
}

// Per-query blast-radius cap. BigQuery rejects (bills 0 for) any query whose
// estimate exceeds `maximumBytesBilled`, so this bounds the damage of a SINGLE
// pathological query — a dropped `WHERE`, a lost `event_type` cluster filter,
// an accidental `SELECT *` — before it runs. Concretely, on the 816 GiB
// `exports_raw` events table a full-column `all`-window scan is ~493 GiB and a
// full-table scan ~816 GiB; both trip this cap and fail loudly in the logs
// instead of billing silently.
//
// What it does NOT catch: aggregate spend from many *individually cheap*
// queries run too often. That frequency class is bounded by the poll timers
// (Query-Rate nur aus dem Poll-Timer). Don't mistake this per-query cap for
// a spend ceiling; it is one layer of defence-in-depth.
//
// Sizing: the heaviest *legitimate* query measured is playbook-stats over the
// `all` window at ~74 GiB (it scans the high-volume `[Amplitude] Page Viewed`
// cluster). Default 300 GiB ≈ 4× the legit max for growth headroom (the `all`
// window grows ~1 day/day), while still far below the 493/816 GiB runaway
// scans. Override via `BIGQUERY_MAX_BYTES_BILLED` (raw bytes).
const DEFAULT_MAX_BYTES_BILLED = 300 * 1024 ** 3; // 300 GiB

function maxBytesBilled(): string {
  const raw = Number(process.env.BIGQUERY_MAX_BYTES_BILLED);
  const bytes = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_BYTES_BILLED;
  return String(bytes);
}

/** Abfrage-Optionen im bisherigen Stil des SDK (benannte Parameter mit
 *  expliziten Typen); die Aufrufer in src/lib/amplitude/* bleiben unberührt. */
export interface BqQuery {
  query: string;
  params?: Record<string, unknown>;
  types?: Record<string, string | string[]>;
}

/** REST-Body-Bausteine für parameterisierte Abfragen (benannt, NAMED). */
function parameterBody(query: BqQuery): Record<string, unknown> {
  if (query.params == null) return {};
  const types = query.types ?? {};
  const queryParameters = Object.entries(query.params).map(([name, value]) => {
    const type = types[name];
    if (Array.isArray(type)) {
      const values = Array.isArray(value) ? value : [value];
      return {
        name,
        parameterType: { type: 'ARRAY', arrayType: { type: type[0] } },
        parameterValue: { arrayValues: values.map((v) => ({ value: String(v) })) },
      };
    }
    return {
      name,
      parameterType: { type: type ?? 'STRING' },
      parameterValue: { value: String(value) },
    };
  });
  return { parameterMode: 'NAMED', queryParameters };
}

interface DryRunResponse {
  totalBytesProcessed?: string | number;
}

/** Dry-Run einer Abfrage; liefert die erwartete Datenmenge in Bytes. */
async function dryRunBytes(sql: string, query: BqQuery): Promise<number> {
  const job = (await bq(`projects/${PROJECT_ID}/queries`, {
    method: 'POST',
    body: {
      query: sql,
      useLegacySql: false,
      dryRun: true,
      ...parameterBody(query),
    },
  })) as DryRunResponse;
  return Number(job.totalBytesProcessed ?? 0);
}

interface SchemaField {
  name: string;
  type?: string;
}

interface QueryResponse {
  jobComplete?: boolean;
  jobReference?: { jobId: string; location: string };
  schema?: { fields?: SchemaField[] };
  rows?: { f: { v: unknown }[] }[];
  pageToken?: string;
}

interface BqCell {
  v: unknown;
}

/** REST-Zellwert normalisieren: { value }-Wrapper auflösen; INT64/FLOAT64/
 *  NUMERIC als Number, BOOL als boolean, alles andere als String. Die
 *  Aufrufer waren gegen SDK-Zeilen geschrieben und vertragen beide Formen
 *  (Number(...) bzw. `.value`-Fallback), aber typisierte Werte brauchen
 *  die wenigsten Anpassungen. */
function cellValue(cell: BqCell, type: string | undefined): unknown {
  let value: unknown = cell.v;
  if (value != null && typeof value === 'object' && 'value' in (value as object)) {
    value = (value as { value: unknown }).value;
  }
  if (value == null) return null;
  if (value != null && typeof value === 'object' && 'arrayValues' in (value as object)) {
    const arr = (value as { arrayValues?: { value?: unknown }[] }).arrayValues ?? [];
    return arr.map((entry) => (entry.value == null ? null : String(entry.value)));
  }
  if (typeof value !== 'string') return value;
  switch (type) {
    case 'INT64':
    case 'INTEGER':
    case 'FLOAT64':
    case 'FLOAT':
    case 'NUMERIC':
    case 'BIGNUMERIC': {
      const num = Number(value);
      return Number.isFinite(num) ? num : value;
    }
    case 'BOOL':
    case 'BOOLEAN':
      return value === 'true';
    default:
      return value;
  }
}

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/** Führt eine Abfrage aus (nach Dry-Run-Kostencheck) und liefert alle
 *  Zeilen als Objekte mit Spaltennamen. Läuft die Abfrage länger als der
 *  erste Request-Slice, wird über getQueryResults gepollt; lange
 *  Ergebnisseiten werden paginiert. Race gegen ein hartes Gesamt-Timeout
 *  wie bisher (BigQueryTimeoutError), damit hängende Jobs den Poll-Takt
 *  nicht blockieren. */
export async function runBigQueryQuery<T = unknown>(
  query: BqQuery,
  timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS,
): Promise<T[]> {
  const cap = maxBytesBilled();
  const bytes = await dryRunBytes(query.query, query);
  if (bytes > Number(cap)) {
    throw new Error(
      `Kosten-Leitplanke: Dry-Run meldet ${(bytes / 1024 ** 3).toFixed(2)} GiB, ` +
        `erlaubt sind ${(Number(cap) / 1024 ** 3).toFixed(0)} GiB. Abbruch.`,
    );
  }

  const deadline = Date.now() + timeoutMs;
  const first = (await bq(`projects/${PROJECT_ID}/queries`, {
    method: 'POST',
    body: {
      query: query.query,
      useLegacySql: false,
      maximumBytesBilled: cap,
      timeoutMs: 10_000,
      maxResults: 1000,
      ...parameterBody(query),
    },
  })) as QueryResponse;

  const jobId = first.jobReference?.jobId;
  const location = first.jobReference?.location;
  if (!jobId || !location) {
    throw new Error('BigQuery: Antwort ohne jobReference.');
  }
  const resultsPath = (pageToken?: string) =>
    `projects/${PROJECT_ID}/queries/${jobId}?location=${location}` +
    `&maxResults=1000&timeoutMs=10000` +
    (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

  const fields = first.schema?.fields ?? [];
  const names = fields.map((f) => f.name);
  const types = fields.map((f) => f.type);
  const rows: T[] = [];
  const pushRows = (page: QueryResponse) => {
    for (const row of page.rows ?? []) {
      const obj: Record<string, unknown> = {};
      row.f.forEach((cell, i) => {
        obj[names[i]] = cellValue(cell, types[i]);
      });
      rows.push(obj as T);
    }
  };

  // Läuft die Abfrage noch, über getQueryResults auf Abschluss warten —
  // gebounct am Gesamt-Timeout des Aufrufers.
  let current = first;
  for (let attempt = 0; current.jobComplete === false; attempt++) {
    if (attempt >= 90 || Date.now() > deadline) {
      throw new BigQueryTimeoutError(timeoutMs);
    }
    current = (await bq(resultsPath())) as QueryResponse;
  }
  pushRows(current);

  // Restliche Ergebnisseiten folgen über pageToken.
  let pageToken = current.pageToken;
  while (pageToken) {
    if (Date.now() > deadline) throw new BigQueryTimeoutError(timeoutMs);
    current = (await bq(resultsPath(pageToken))) as QueryResponse;
    pushRows(current);
    pageToken = current.pageToken;
  }
  return rows;
}
