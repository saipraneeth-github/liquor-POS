import { useEffect, useState } from 'react';

const desktopQuery = '(min-width: 768px)';

export function useDesktopViewport() {
  const [desktop, setDesktop] = useState(() => window.matchMedia(desktopQuery).matches);

  useEffect(() => {
    const query = window.matchMedia(desktopQuery);
    const update = () => setDesktop(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);

  return desktop;
}
