import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LANGUAGES, MESSAGES, type LangCode } from './messages';

import { applyTranslations } from './dom-translate';

const KEY = 'lang';
async function loadBulk(lang: LangCode): Promise<Record<string, string>> {
  if (lang === 'hi') return (await import('./generated.hi')).default;
  if (lang === 'te') return (await import('./generated.te')).default;
  return {};
}
interface Ctx { lang: LangCode; setLang: (l: LangCode) => void; t: (text: string) => string }

function initial(): LangCode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved as LangCode;
  } catch { /* storage blocked: English */ }
  return 'en';
}

const LanguageContext = createContext<Ctx>({ lang: 'en', setLang: () => {}, t: (s) => s });

/** Interface language for menus, buttons and labels. Data (products, names, amounts) is never translated. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<LangCode>(initial);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const setLang = useCallback((l: LangCode) => {
    setLangState(l);
    try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  }, []);
  const [bulk, setBulk] = useState<Record<string, string>>({});
  // The big dictionary for the page-wide translator loads on demand, so English users never download it
  useEffect(() => {
    let live = true;
    if (lang === 'en') { setBulk({}); applyTranslations(null); return; }
    loadBulk(lang).then((b) => {
      if (!live) return;
      const merged = { ...b, ...MESSAGES[lang] };
      setBulk(merged);
      applyTranslations(merged);
    }).catch(() => { if (live) applyTranslations(MESSAGES[lang]); });
    return () => { live = false; };
  }, [lang]);
  const value = useMemo<Ctx>(() => ({ lang, setLang, t: (text) => bulk[text] ?? MESSAGES[lang][text] ?? text }), [lang, setLang, bulk]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useT = () => useContext(LanguageContext);

/** Compact picker for the header. */
export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { lang, setLang, t } = useT();
  return (
    <select
      id="languageSelect"
      aria-label={t('Language')}
      title={t('Language')}
      value={lang}
      onChange={(e) => setLang(e.target.value as LangCode)}
      className={`p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/60 text-xs font-medium text-gray-700 dark:text-gray-200 cursor-pointer shrink-0 ${className}`}
    >
      {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
    </select>
  );
}
