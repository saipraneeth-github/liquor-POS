import beerLoaderGif from '../assets/Beer-loader.gif';

export interface BeerBottleLoaderProps {
  open?: boolean;
  inline?: boolean;
  size?: 'sm' | 'md' | 'lg';
  title?: string;
  subtitle?: string;
  text?: string;
  stage?: 'saving' | 'inwarding' | 'refreshing' | string;
  bottlesCount?: number;
  totalCost?: string | number;
  className?: string;
}

export function BeerBottleLoader({
  open = true,
  inline = false,
  size = 'md',
  title,
  subtitle,
  text,
  stage,
  bottlesCount,
  totalCost,
  className = '',
}: BeerBottleLoaderProps) {
  // If used as an overlay dialog, honor the open prop
  if (!inline && !open) return null;

  const displayTitle = title || text || (inline ? 'Pouring data…' : 'Pouring Stock into Inventory...');
  const isSm = size === 'sm';
  const isLg = size === 'lg';

  // ── INLINE / SECTION VARIANT ──────────────────────────────────────────────
  if (inline) {
    const gifDimensions = isSm ? 'w-20 h-16' : isLg ? 'w-40 h-30' : 'w-28 h-21';
    return (
      <div
        className={`flex flex-col items-center justify-center p-6 sm:p-8 text-center select-none animate-fadeIn ${className}`}
        role="status"
        aria-live="polite"
      >
        {/* Transparent container showing ONLY the animated GIF object with NO background box */}
        <div className={`relative ${gifDimensions} mb-3 flex items-center justify-center`}>
          <img
            src={beerLoaderGif}
            alt="Loading animation"
            className="w-full h-full object-contain"
          />
        </div>
        <div className={`font-bold text-gray-900 dark:text-gray-100 ${isSm ? 'text-sm' : 'text-base'}`}>
          {displayTitle}
        </div>
        {subtitle && (
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-xs leading-relaxed">
            {subtitle}
          </div>
        )}
      </div>
    );
  }

  // ── FULLSCREEN OVERLAY MODAL VARIANT (SHOWS ONLY THE GIF OBJECT ON BLURRED OVERLAY) ──
  return (
    <div
      className={`fixed inset-0 z-[9999] bg-black/70 backdrop-blur-md flex flex-col items-center justify-center p-4 transition-all duration-300 animate-fadeIn select-none pointer-events-auto ${className}`}
      role="status"
      aria-live="polite"
      aria-label={displayTitle}
    >
      <div className="flex flex-col items-center justify-center text-center max-w-sm sm:max-w-md w-full">
        {/* Transparent container showing ONLY the animated GIF object with NO background box */}
        <div className="relative w-48 h-36 sm:w-60 sm:h-44 mb-3 flex items-center justify-center">
          <img
            src={beerLoaderGif}
            alt="Loading animation"
            className="w-full h-full object-contain mix-blend-screen"
          />
        </div>

        {/* Status Headings directly on dimmed backdrop */}
        <h3 className="text-xl sm:text-2xl font-bold text-white tracking-tight drop-shadow-md mb-1">
          {displayTitle}
        </h3>
        {subtitle && (
          <p className="text-sm text-amber-200/90 max-w-xs leading-relaxed drop-shadow mb-3">
            {subtitle}
          </p>
        )}

        {/* Dynamic Detail Pill */}
        {(bottlesCount !== undefined || totalCost !== undefined) && (
          <div className="flex items-center gap-3 bg-amber-500/20 border border-amber-400/40 backdrop-blur-sm rounded-full px-4 py-1.5 text-xs font-semibold text-amber-200 mb-3 drop-shadow">
            {bottlesCount !== undefined && (
              <span><strong>{bottlesCount}</strong> bottles inwarding</span>
            )}
            {bottlesCount !== undefined && totalCost !== undefined && (
              <span className="text-amber-400/60">•</span>
            )}
            {totalCost !== undefined && (
              <span>₹{Number(totalCost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
            )}
          </div>
        )}

        {/* Progress Stages Pipeline */}
        {stage && (
          <div className="w-full max-w-xs bg-black/40 backdrop-blur-md rounded-xl p-3 border border-white/10 flex flex-col gap-2 mt-2">
            <div className="flex items-center justify-between text-xs font-medium text-slate-300">
              <span className={stage === 'saving' ? 'text-amber-400 font-bold flex items-center gap-1' : 'text-emerald-400 font-semibold'}>
                {stage === 'saving' ? '1. Saving bill...' : '✓ 1. Bill saved'}
              </span>
              <span className={stage === 'inwarding' ? 'text-amber-400 font-bold flex items-center gap-1' : stage === 'refreshing' ? 'text-emerald-400 font-semibold' : ''}>
                {stage === 'inwarding' ? '2. Inwarding...' : stage === 'refreshing' ? '✓ 2. Inwarded' : '2. Inwarding'}
              </span>
              <span className={stage === 'refreshing' ? 'text-amber-400 font-bold flex items-center gap-1' : ''}>
                {stage === 'refreshing' ? '3. Ledger...' : '3. Ledger'}
              </span>
            </div>

            <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-amber-500 via-amber-400 to-yellow-300 rounded-full transition-all duration-500 relative"
                style={{
                  width: stage === 'saving' ? '35%' : stage === 'inwarding' ? '75%' : '98%',
                }}
              >
                <div className="absolute inset-0 bg-white/30 animate-pulse" />
              </div>
            </div>
          </div>
        )}

        <div className="mt-3 text-[11px] text-slate-300/80 font-medium drop-shadow">
          Database operation in progress. Please do not refresh.
        </div>
      </div>
    </div>
  );
}
