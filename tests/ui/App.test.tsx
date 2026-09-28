// @vitest-environment jsdom
// Smoke tests for the page as a whole: the main path works, and bad input is shown instead of crashing.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { runInProcess } from '../../src/ui/simulation';

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
    // Verifies: the demo is analyzed right away: the summary names 12 findings and 12 findings are listed.
    render(<App />);
    expect(screen.getByText('12 findings across api, orders, db.')).toBeTruthy();
    expect(screen.getAllByTestId('finding')).toHaveLength(12);
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
    //   recovered as soon as the fault ended, and the near-zero-during-the-fault note is shown.
    render(<App runSimulation={runInProcess} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply 12 mitigations and simulate' }));
    expect(screen.getByRole('status').textContent).toContain('Running the simulation');
    const results = await screen.findByTestId('results', {}, { timeout: 30_000 });
    expect(results.textContent).toContain('the original config never recovered');
    expect(results.textContent).toContain('the mitigated config recovered as soon as it ended');
    expect(screen.getByRole('row', { name: /^Recovery/ }).textContent).toBe('Recoverydid not recoverafter 0 s');
    expect(screen.getByTestId('during-fault-note')).toBeTruthy();
  }, 60_000);
});
