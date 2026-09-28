import { describe, expect, it } from 'vitest';
import { analyze } from '../../../src/engine/analyzer/analyze';
import { demoSystem } from '../../helpers/fixtures';

describe('analyze on the demo (DESIGN.md §11.3)', () => {
  const { findings } = analyze(demoSystem());

  it('produces exactly the 12 expected findings', () => {
    // Plan: analyze the demo system.
    // Verifies: the finding ids match DESIGN.md §11.3, grouped by rule in RULES order.
    expect(findings.map((f) => f.id)).toEqual([
      'retry-amplification:api.placeOrder',
      'deadline-budget-overrun:api.placeOrder',
      'deadline-budget-overrun:orders.writeOrder',
      'unguarded-retries:api.placeOrder',
      'unguarded-retries:orders.readStock',
      'unguarded-retries:orders.writeOrder',
      'missing-deadline-propagation:api',
      'missing-deadline-propagation:orders',
      'missing-deadline-propagation:db',
      'dead-on-arrival-queue:api',
      'dead-on-arrival-queue:orders',
      'dead-on-arrival-queue:db',
    ]);
  });

  it('recommends the expected patches', () => {
    // Plan: collect each finding's patches as "target.field → value".
    // Verifies: the attempts and queue values match DESIGN.md §11.3 (e.g. writeOrder 3 → 2, db queue → 26).
    const patches = Object.fromEntries(
      findings.map((f) => [f.id, f.mitigation?.patches.map((p) => `${p.field} → ${JSON.stringify(p.to)}`).join('; ')]),
    );
    expect(patches).toMatchObject({
      'retry-amplification:api.placeOrder': 'maxAttempts → 1',
      'deadline-budget-overrun:api.placeOrder': 'maxAttempts → 1',
      'deadline-budget-overrun:orders.writeOrder': 'maxAttempts → 2',
      'dead-on-arrival-queue:api': 'queueCapacity → 95',
      'dead-on-arrival-queue:orders': 'queueCapacity → 85',
      'dead-on-arrival-queue:db': 'queueCapacity → 26',
    });
  });

  it('explains amplification with the demo numbers', () => {
    // Plan: read the retry-amplification finding.
    // Verifies: one user request can cause up to 3 × (3 + 3) = 18 attempts at the db.
    expect(findings[0]?.evidence.worstAttemptsPerRequest).toBe(18);
  });
});
