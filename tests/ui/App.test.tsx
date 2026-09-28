// @vitest-environment jsdom
// Smoke tests for the page as a whole: the main path works, and bad input is shown instead of crashing.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { runInProcess, type RunSimulation, type SimulationInput } from '../../src/ui/simulation';

// jsdom has no layout; the charts only need ResizeObserver to exist.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

describe('App', () => {
  it('shows the demo and its 12 findings on first visit', () => {
    // Plan: render the page with no interaction.
    // Verifies: the demo is analyzed right away: the top counts 12 findings (6 high) and 12 are listed.
    render(<App />);
    expect(screen.getByText('12 findings')).toBeTruthy();
    expect(screen.getByText(/6 high · 6 medium, across api, orders, db/)).toBeTruthy();
    expect(screen.getAllByTestId('finding')).toHaveLength(12);
  });

  it('lists high findings first, collapsed, with the explanation behind "Why?"', () => {
    // Plan: render, check the severity order, then open the first finding.
    // Verifies: the six high findings come before the six medium ones; no explanation shows until "Why?" is
    //   clicked, and then only that finding's.
    render(<App />);
    const findings = screen.getAllByTestId('finding');
    expect(findings.map((f) => f.querySelector('.severity')?.textContent)).toEqual([
      ...Array<string>(6).fill('High'),
      ...Array<string>(6).fill('Medium'),
    ]);
    expect(document.querySelectorAll('.finding-more')).toHaveLength(0);
    const [firstWhy] = screen.getAllByRole('button', { name: 'Why?' });
    if (firstWhy) fireEvent.click(firstWhy);
    expect(document.querySelectorAll('.finding-more')).toHaveLength(1);
    expect(findings[0]?.textContent).toContain('Each layer');
  });

  it('applies all mitigations and finds nothing left', () => {
    // Plan: click the Apply button of step 3 (applies without simulating).
    // Verifies: the mitigation result appears and the re-check reports nothing unresolved or new.
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply 12 selected' }));
    expect(screen.getByTestId('mitigation-result').textContent).toContain('A re-check of the mitigated config finds nothing left.');
  });

  it('shows a validation error with its path instead of crashing', () => {
    // Plan: open the editor and set the db's workers to 0.
    // Verifies: the error is listed with its field path, the editor stays open to fix it, and the findings
    //   step explains why it is empty.
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit the config' }));
    const editor = screen.getByLabelText('System config (YAML)') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: editor.value.replace('workers: 4', 'workers: 0') } });
    expect(screen.getByRole('alert').textContent).toContain('services.db.workers');
    expect(screen.getByText('The findings appear once the system config is valid.')).toBeTruthy();
    expect(screen.getByLabelText('System config (YAML)')).toBeTruthy();
  });

  it('applies and simulates in one click and shows the recovery of both configs', async () => {
    // Plan: render with the in-process runner (no worker in jsdom) and click the primary button.
    // Verifies: the loading state shows, then the results: the original did not recover, the mitigated one
    //   recovered immediately, and the near-zero-during-the-fault note is shown.
    render(<App runSimulation={runInProcess} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quick demo: apply all 12 fixes and simulate' }));
    expect(screen.getByRole('status').textContent).toContain('Running the simulation');
    const results = await screen.findByTestId('results', {}, { timeout: 30_000 });
    expect(results.textContent).toContain('After db was slowed 5× from 10 to 20 s:');
    expect(screen.getByTestId('outcome-original').textContent).toContain('Did not recover');
    expect(screen.getByTestId('outcome-mitigated').textContent).toContain('Recovered immediately');
    expect(screen.getByRole('row', { name: /^Recovery/ }).textContent).toBe('Recoverydid not recoverimmediately');
    expect(screen.getByTestId('during-fault-note')).toBeTruthy();
  }, 60_000);

  it('simulates exactly the selected fixes when only some are selected', () => {
    // Plan: select none, then only the db queue finding, and click the top button with a runner that records
    //   its input and never finishes.
    // Verifies: the button no longer says "Quick demo"; the mitigated config has only db's queue capped (26),
    //   everything else as in the original; the original config is unchanged.
    const inputs: SimulationInput[] = [];
    const recording: RunSimulation = (input) => {
      inputs.push(input);
      return new Promise(() => {});
    };
    render(<App runSimulation={recording} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));
    fireEvent.click(screen.getByLabelText(/Apply the mitigation for: A full db queue/));
    fireEvent.click(screen.getByRole('button', { name: 'Shortcut: apply 1 selected fix and simulate' }));

    const [input] = inputs;
    expect(input?.mitigated.services.db).toEqual({ ...input?.original.services.db, queueCapacity: 26 });
    expect({ ...input?.mitigated, services: { ...input?.mitigated.services, db: input?.original.services.db } }).toEqual(
      input?.original,
    );
    expect(input?.original.services.db?.queueCapacity).toBe(1000);
  });

  it('resets to the demo, clearing results', async () => {
    // Plan: simulate the demo, open the editor, break the system config, then click "Reset to demo".
    // Verifies: the button is disabled while the demo is unchanged; after the reset the 12 findings are back
    //   and steps 3 and 4 show their previews instead of the old, out-of-date results.
    render(<App runSimulation={runInProcess} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quick demo: apply all 12 fixes and simulate' }));
    await screen.findByTestId('results', {}, { timeout: 30_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit the config' }));
    const reset = screen.getByRole('button', { name: 'Reset to demo' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);

    const editor = screen.getByLabelText('System config (YAML)') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: editor.value.replace('workers: 4', 'workers: 0') } });
    expect(screen.queryAllByTestId('finding')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to demo' }));

    expect(screen.getAllByTestId('finding')).toHaveLength(12);
    expect(screen.queryByTestId('results')).toBeNull();
    expect(screen.queryByTestId('mitigation-result')).toBeNull();
    expect(screen.getByText(/Results appear here/)).toBeTruthy();
  }, 60_000);
});
