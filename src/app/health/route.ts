// Liveness/Readiness-Probe für nautilus (.sipgate/nautilus.yaml).
// Meldet zusätzlich den Stand des Runtime-Pollers: je Domain und Variante
// der letzte erfolgreiche Abruf (stand), der letzte Versuch
// (lastAttemptAt) und der letzte Fehler (error, null wenn der letzte Poll
// erfolgreich war). Die Probe bleibt 200, solange der Server antwortet —
// ein gestörter Datenfluss erkennt man am error-Feld, nicht am Statuscode.

import { getStatuses } from '@/lib/runtime/store';

export function GET() {
  return new Response(
    JSON.stringify({
      ok: true,
      domains: getStatuses(),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
