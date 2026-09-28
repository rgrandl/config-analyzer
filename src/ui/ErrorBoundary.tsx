// Keeps one panel's crash from taking the whole page down; shows what failed instead.
import { Component, type ReactNode } from 'react';

interface Props {
  /** What the panel does, for the message: "the call graph". */
  readonly name: string;
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notice notice-error" role="alert">
        <p>Showing {this.props.name} failed: {this.state.error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
