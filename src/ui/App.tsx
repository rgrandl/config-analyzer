// Placeholder page for milestone 1. It proves that the demo YAML is bundled and parses in the deployed build.
import { parse } from 'yaml';
import { DEMO_SYSTEM_YAML } from '../demo';

const DESIGN_URL = 'https://github.com/rgrandl/config-analyzer/blob/main/DESIGN.md';

function demoServiceNames(): string[] {
  const doc: unknown = parse(DEMO_SYSTEM_YAML);
  if (typeof doc !== 'object' || doc === null || !('services' in doc)) return [];
  const services = (doc as { services: unknown }).services;
  return typeof services === 'object' && services !== null ? Object.keys(services) : [];
}

export function App() {
  const services = demoServiceNames();
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '48px auto', padding: '0 16px' }}>
      <h1>Config Interaction Analyzer</h1>
      <p>
        Finds resilience settings that are reasonable per service but risky in combination, recommends
        mitigations, and simulates their effect.
      </p>
      <p>
        Under construction. Demo system: <strong>{services.join(' → ')}</strong>
      </p>
      <p>
        <a href={DESIGN_URL}>Read the design</a>
      </p>
    </main>
  );
}
