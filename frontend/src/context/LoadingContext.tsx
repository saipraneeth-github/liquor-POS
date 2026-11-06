import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { BeerBottleLoader } from '../components/BeerBottleLoader';

interface LoadingState {
  isLoading: boolean;
  title?: string;
  subtitle?: string;
}

interface LoadingContextType extends LoadingState {
  startLoading: (title?: string, subtitle?: string) => void;
  stopLoading: () => void;
  withLoading: <T>(action: () => Promise<T>, title?: string, subtitle?: string) => Promise<T>;
}

const LoadingContext = createContext<LoadingContextType>({
  isLoading: false,
  startLoading: () => {},
  stopLoading: () => {},
  withLoading: (action) => action(),
});

// Singleton emitter for non-React contexts (such as api client)
type LoadingListener = (state: LoadingState) => void;
const listeners = new Set<LoadingListener>();
let globalCount = 0;
let globalTitle: string | undefined = undefined;
let globalSubtitle: string | undefined = undefined;

function notifyListeners() {
  const state: LoadingState = {
    isLoading: globalCount > 0,
    title: globalTitle,
    subtitle: globalSubtitle,
  };
  listeners.forEach((l) => l(state));
}

export function startGlobalLoading(title?: string, subtitle?: string) {
  globalCount++;
  if (title) globalTitle = title;
  if (subtitle) globalSubtitle = subtitle;
  notifyListeners();
}

export function stopGlobalLoading() {
  globalCount = Math.max(0, globalCount - 1);
  if (globalCount === 0) {
    globalTitle = undefined;
    globalSubtitle = undefined;
  }
  notifyListeners();
}

export async function runWithGlobalLoading<T>(
  action: () => Promise<T>,
  title?: string,
  subtitle?: string,
): Promise<T> {
  startGlobalLoading(title, subtitle);
  try {
    return await action();
  } finally {
    stopGlobalLoading();
  }
}

export function LoadingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LoadingState>({
    isLoading: false,
    title: undefined,
    subtitle: undefined,
  });

  const activeCountRef = useRef(0);

  useEffect(() => {
    const listener: LoadingListener = (newState) => {
      setState(newState);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const startLoading = useCallback((title?: string, subtitle?: string) => {
    activeCountRef.current++;
    startGlobalLoading(title, subtitle);
  }, []);

  const stopLoading = useCallback(() => {
    activeCountRef.current = Math.max(0, activeCountRef.current - 1);
    stopGlobalLoading();
  }, []);

  const withLoading = useCallback(async <T,>(action: () => Promise<T>, title?: string, subtitle?: string): Promise<T> => {
    startLoading(title, subtitle);
    try {
      return await action();
    } finally {
      stopLoading();
    }
  }, [startLoading, stopLoading]);

  // Global button click interceptor:
  // When action buttons or submit buttons are clicked, ensures interaction is immediately locked
  // to prevent rapid double-clicks while the async operation is firing.
  useEffect(() => {
    const handleButtonClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const button = target?.closest('button');
      if (!button || button.disabled || button.getAttribute('data-no-loading') === 'true') {
        return;
      }

      // If button triggers a submit or action, prevent duplicate clicks
      if (globalCount > 0) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };

    document.addEventListener('click', handleButtonClick, true);
    return () => {
      document.removeEventListener('click', handleButtonClick, true);
    };
  }, []);

  return (
    <LoadingContext.Provider
      value={{
        isLoading: state.isLoading,
        title: state.title,
        subtitle: state.subtitle,
        startLoading,
        stopLoading,
        withLoading,
      }}
    >
      {children}
      {/* Full-screen blocking interaction overlay */}
      <BeerBottleLoader
        open={state.isLoading}
        inline={false}
        title={state.title || 'Processing Action…'}
        subtitle={state.subtitle || 'Please wait while the server completes the operation.'}
      />
    </LoadingContext.Provider>
  );
}

export function useLoading() {
  return useContext(LoadingContext);
}

