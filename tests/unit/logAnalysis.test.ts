import { describe, expect, it } from 'vitest';
import { analyze, toMarkdown } from '../../src/tools/logAnalysis.js';

const t0 = Date.parse('2026-01-01T10:00:00.000Z');
const at = (sec: number) => new Date(t0 + sec * 1000).toISOString();
const beat = (sec: number, status: 'healthy' | 'unhealthy') =>
  JSON.stringify({
    time: at(sec),
    level: status === 'healthy' ? 'info' : 'error',
    levelValue: status === 'healthy' ? 30 : 50,
    event: 'health.heartbeat',
    status,
    intervalMs: 10_000,
  });
const req = (sec: number, status: number) =>
  JSON.stringify({
    time: at(sec),
    level: status >= 500 ? 'error' : 'info',
    levelValue: status >= 500 ? 50 : 30,
    event: 'http.request',
    status,
  });

describe('Log-Auswertung', () => {
  it('100 % Verfügbarkeit bei durchgehend gesunden Heartbeats', () => {
    const lines = [0, 10, 20, 30].map((s) => beat(s, 'healthy'));
    const r = analyze(lines);
    expect(r.availability.availabilityPct).toBe(100);
    expect(r.availability.downtimeSec).toBe(0);
  });

  it('zählt unhealthy-Heartbeats als Ausfall', () => {
    const lines = [
      beat(0, 'healthy'),
      beat(10, 'unhealthy'),
      beat(20, 'unhealthy'),
      beat(30, 'healthy'),
    ];
    const r = analyze(lines);
    // 4 Intervalle à 10 s, davon 2 ungesund
    expect(r.availability.availabilityPct).toBe(50);
    expect(r.availability.unhealthyHeartbeats).toBe(2);
  });

  it('erkennt Lücken (Prozess weg) als Ausfall', () => {
    // Heartbeat bei 0 und erst wieder bei 60 s -> 50 s Lücke
    const lines = [beat(0, 'healthy'), beat(60, 'healthy')];
    const r = analyze(lines);
    expect(r.availability.gaps).toBe(1);
    expect(r.availability.downtimeSec).toBe(50);
    expect(r.availability.uptimeSec).toBe(20);
  });

  it('berechnet 5xx-Quote und Error-Events, ignoriert Fremdzeilen', () => {
    const lines = [
      req(1, 200),
      req(2, 200),
      req(3, 404),
      req(4, 500),
      'kein json',
      '',
      beat(5, 'healthy'),
    ];
    const r = analyze(lines);
    expect(r.requests.total).toBe(4);
    expect(r.requests.status5xx).toBe(1);
    expect(r.requests.errorRatePct).toBe(25);
    expect(r.errors.count).toBe(1);
    expect(r.errors.top[0]).toEqual({ key: 'http.request', count: 1 });
    expect(r.lines.unparsed).toBe(1);
  });

  it('filtert mit --since', () => {
    const lines = [req(1, 500), req(100, 200)];
    const r = analyze(lines, { since: new Date(at(50)) });
    expect(r.requests.total).toBe(1);
    expect(r.requests.status5xx).toBe(0);
  });

  it('erzeugt lesbares Markdown', () => {
    const md = toMarkdown(analyze([beat(0, 'healthy'), req(1, 500)]));
    expect(md).toContain('# Log-Auswertung');
    expect(md).toContain('Verfügbarkeit');
  });
});
