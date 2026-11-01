import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught rendering error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  handleReload = () => {
    window.location.reload();
  };

  handleHome = () => {
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-[400px] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 p-6 text-center space-y-4">
            <div className="w-14 h-14 mx-auto rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center text-red-600 dark:text-red-400">
              <AlertTriangle size={30} />
            </div>
            <div>
              <h2 className="text-lg font-bold">
                Something went wrong
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                An unexpected error occurred while rendering this page.
              </p>
            </div>

            {this.state.error && (
              <div className="text-left bg-gray-50 dark:bg-gray-900/60 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                <div className="text-[11px] font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide">
                  Error Details
                </div>
                <div className="text-xs font-mono text-gray-700 dark:text-gray-300 mt-1 break-words">
                  {this.state.error.message || String(this.state.error)}
                </div>
              </div>
            )}

            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-purple-600 hover:bg-purple-700 text-white transition-colors cursor-pointer"
              >
                <RefreshCw size={14} />
                Try again
              </button>
              <button
                type="button"
                onClick={this.handleHome}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 transition-colors cursor-pointer"
              >
                <Home size={14} />
                Dashboard
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
