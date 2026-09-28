// @vitest-environment jsdom
// Smoke tests for the page as a whole: the main path works, and bad input is shown instead of crashing.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';

afterEach(cleanup);

describe('App', () => {
  it('shows the demo and its 12 findings on first visit', () => {
    // Plan: render the page with no interaction.
    // Verifies: the demo is analyzed right away: the summary names 12 combinations and 12 findings are listed.
    render(<App />);
    expect(screen.getByText('12 risky combinations across api, orders, db.')).toBeTruthy();
    expect(screen.getAllByTestId('finding')).toHaveLength(12);
  });

  it('applies all mitigations in one click and finds nothing left', () => {
    // Plan: click the primary button at the top of the page.
    // Verifies: the mitigation result appears and the re-check reports nothing unresolved or new.
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply 12 mitigations' }));
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
});
