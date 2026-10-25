/** Процесс жив (ADR-0001, п. 6). */
export function GET() {
  return Response.json({ status: 'ok' });
}
