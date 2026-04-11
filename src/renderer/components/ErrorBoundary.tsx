import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, error: err.message || 'Unknown render error' };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] React render crash:', err, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '24px',
          color: 'rgba(255,255,255,0.7)',
          fontFamily: 'inherit',
          fontSize: '13px',
        }}>
          <div style={{ color: '#f87171', fontWeight: 600, marginBottom: '8px' }}>
            Render Error
          </div>
          <div style={{ marginBottom: '12px', opacity: 0.6 }}>{this.state.error}</div>
          <button
            onClick={this.handleReset}
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '4px',
              color: 'rgba(255,255,255,0.8)',
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
