import { Component } from 'react';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="vh-100 d-flex align-items-center justify-content-center bg-dark px-3">
          <div className="card shadow" style={{ maxWidth: 500, width: '100%' }}>
            <div className="card-body p-4 text-center">
              <i className="bi bi-exclamation-triangle fs-1 text-danger"></i>
              <h5 className="mt-3">Something went wrong</h5>
              <p className="text-muted small">{this.state.error?.message || 'An unexpected error occurred.'}</p>
              <button className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
