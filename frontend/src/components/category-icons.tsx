import type { ComponentType } from 'react';
import { Beer, Wine, Martini, Flame, Sparkles, GlassWater, Utensils, CupSoda } from 'lucide-react';

export interface CategoryInfo {
  type: 'beer' | 'wine' | 'whisky' | 'vodka' | 'rum' | 'gin' | 'brandy' | 'food' | 'liquor';
  label: string;
  emoji: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
  badgeClass: string;
  iconColorClass: string;
  dotColorClass: string;
}

export function getCategoryInfo(categoryName?: string | null, productName?: string | null): CategoryInfo {
  const cat = (categoryName || '').toLowerCase().trim();
  const prod = (productName || '').toLowerCase().trim();
  const combined = `${cat} ${prod}`;

  // 1. BEER
  if (
    cat.includes('beer') ||
    combined.includes('beer') ||
    combined.includes('lager') ||
    combined.includes('ale') ||
    combined.includes('pilsner') ||
    combined.includes('stout') ||
    combined.includes('draught') ||
    combined.includes('kingfisher') ||
    combined.includes('budweiser') ||
    combined.includes('carlsberg') ||
    combined.includes('tuborg') ||
    combined.includes('bira') ||
    combined.includes('heineken') ||
    combined.includes('corona')
  ) {
    return {
      type: 'beer',
      label: categoryName?.trim() || 'Beer',
      emoji: '🍺',
      Icon: Beer,
      badgeClass: 'bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-950/60 dark:text-amber-200 dark:border-amber-800',
      iconColorClass: 'text-amber-600 dark:text-amber-400',
      dotColorClass: 'bg-amber-500',
    };
  }

  // 2. WINE
  if (
    cat.includes('wine') ||
    combined.includes('wine') ||
    combined.includes('shiraz') ||
    combined.includes('merlot') ||
    combined.includes('cabernet') ||
    combined.includes('sauvignon') ||
    combined.includes('chardonnay') ||
    combined.includes('sula') ||
    combined.includes('jacob') ||
    combined.includes('fratelli') ||
    combined.includes('port wine') ||
    combined.includes('champagne') ||
    combined.includes('prosecco')
  ) {
    return {
      type: 'wine',
      label: categoryName?.trim() || 'Wine',
      emoji: '🍷',
      Icon: Wine,
      badgeClass: 'bg-rose-100 text-rose-900 border-rose-300 dark:bg-rose-950/60 dark:text-rose-200 dark:border-rose-800',
      iconColorClass: 'text-rose-600 dark:text-rose-400',
      dotColorClass: 'bg-rose-500',
    };
  }

  // 3. WHISKY / WHISKEY
  if (
    cat.includes('whisky') ||
    cat.includes('whiskey') ||
    cat.includes('scotch') ||
    combined.includes('whisky') ||
    combined.includes('whiskey') ||
    combined.includes('scotch') ||
    combined.includes('bourbon') ||
    combined.includes('malt') ||
    combined.includes('blenders pride') ||
    combined.includes('royal stag') ||
    combined.includes('imperial blue') ||
    combined.includes('mcdowell') ||
    combined.includes('signature') ||
    combined.includes('antiquity') ||
    combined.includes('black dog') ||
    combined.includes('red label') ||
    combined.includes('black label') ||
    combined.includes('chivas') ||
    combined.includes('glenfiddich') ||
    combined.includes('jameson') ||
    combined.includes('jack daniel')
  ) {
    return {
      type: 'whisky',
      label: categoryName?.trim() || 'Whisky',
      emoji: '🥃',
      Icon: Flame,
      badgeClass: 'bg-orange-100 text-orange-950 border-orange-300 dark:bg-orange-950/60 dark:text-orange-200 dark:border-orange-800',
      iconColorClass: 'text-orange-600 dark:text-orange-400',
      dotColorClass: 'bg-orange-500',
    };
  }

  // 4. VODKA
  if (
    cat.includes('vodka') ||
    combined.includes('vodka') ||
    combined.includes('magic moments') ||
    combined.includes('smirnoff') ||
    combined.includes('absolut') ||
    combined.includes('grey goose') ||
    combined.includes('romanov') ||
    combined.includes('ketel one')
  ) {
    return {
      type: 'vodka',
      label: categoryName?.trim() || 'Vodka',
      emoji: '🍸',
      Icon: GlassWater,
      badgeClass: 'bg-sky-100 text-sky-900 border-sky-300 dark:bg-sky-950/60 dark:text-sky-200 dark:border-sky-800',
      iconColorClass: 'text-sky-600 dark:text-sky-400',
      dotColorClass: 'bg-sky-500',
    };
  }

  // 5. RUM
  if (
    cat.includes('rum') ||
    combined.includes('rum') ||
    combined.includes('old monk') ||
    combined.includes('bacardi') ||
    combined.includes('captain morgan') ||
    combined.includes('havana')
  ) {
    return {
      type: 'rum',
      label: categoryName?.trim() || 'Rum',
      emoji: '🍹',
      Icon: CupSoda,
      badgeClass: 'bg-amber-100 text-amber-950 border-amber-400 dark:bg-amber-950/80 dark:text-amber-100 dark:border-amber-700',
      iconColorClass: 'text-amber-700 dark:text-amber-300',
      dotColorClass: 'bg-amber-700',
    };
  }

  // 6. GIN
  if (
    cat.includes('gin') ||
    combined.includes('gin') ||
    combined.includes('blue riband') ||
    combined.includes('bombay sapphire') ||
    combined.includes('tanqueray') ||
    combined.includes('beefeater') ||
    combined.includes('gordon') ||
    combined.includes('greater than') ||
    combined.includes('jaisalmer')
  ) {
    return {
      type: 'gin',
      label: categoryName?.trim() || 'Gin',
      emoji: '🌿',
      Icon: Sparkles,
      badgeClass: 'bg-teal-100 text-teal-900 border-teal-300 dark:bg-teal-950/60 dark:text-teal-200 dark:border-teal-800',
      iconColorClass: 'text-teal-600 dark:text-teal-400',
      dotColorClass: 'bg-teal-500',
    };
  }

  // 7. BRANDY
  if (
    cat.includes('brandy') ||
    combined.includes('brandy') ||
    combined.includes('cognac') ||
    combined.includes('mansion house') ||
    combined.includes('honey bee') ||
    combined.includes('morpheus') ||
    combined.includes('courvoisier') ||
    combined.includes('hennessy')
  ) {
    return {
      type: 'brandy',
      label: categoryName?.trim() || 'Brandy',
      emoji: '🍇',
      Icon: Wine,
      badgeClass: 'bg-purple-100 text-purple-900 border-purple-300 dark:bg-purple-950/60 dark:text-purple-200 dark:border-purple-800',
      iconColorClass: 'text-purple-600 dark:text-purple-400',
      dotColorClass: 'bg-purple-500',
    };
  }

  // 8. FOOD (Starters, Main Course, Kitchen, Snacks)
  if (
    cat.includes('starter') ||
    cat.includes('main course') ||
    cat.includes('food') ||
    cat.includes('kitchen') ||
    combined.includes('biryani') ||
    combined.includes('chicken') ||
    combined.includes('paneer') ||
    combined.includes('tikka') ||
    combined.includes('roti') ||
    combined.includes('curry') ||
    combined.includes('snack')
  ) {
    return {
      type: 'food',
      label: categoryName?.trim() || 'Food',
      emoji: '🍽️',
      Icon: Utensils,
      badgeClass: 'bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-200 dark:border-emerald-800',
      iconColorClass: 'text-emerald-600 dark:text-emerald-400',
      dotColorClass: 'bg-emerald-500',
    };
  }

  // 9. DEFAULT LIQUOR / SPIRIT
  return {
    type: 'liquor',
    label: categoryName?.trim() || 'Spirits',
    emoji: '🍾',
    Icon: Martini,
    badgeClass: 'bg-indigo-100 text-indigo-900 border-indigo-300 dark:bg-indigo-950/60 dark:text-indigo-200 dark:border-indigo-800',
    iconColorClass: 'text-indigo-600 dark:text-indigo-400',
    dotColorClass: 'bg-indigo-500',
  };
}

export function CategoryBadge({
  categoryName,
  productName,
  showLabel = true,
  className = '',
}: {
  categoryName?: string | null;
  productName?: string | null;
  showLabel?: boolean;
  className?: string;
}) {
  const info = getCategoryInfo(categoryName, productName);
  const { Icon } = info;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold border ${info.badgeClass} ${className}`}
      title={info.label}
    >
      <Icon size={12} className="shrink-0" />
      <span className="shrink-0">{info.emoji}</span>
      {showLabel && <span>{info.label}</span>}
    </span>
  );
}

export function CategoryIcon({
  categoryName,
  productName,
  size = 20,
  className = '',
}: {
  categoryName?: string | null;
  productName?: string | null;
  size?: number;
  className?: string;
}) {
  const info = getCategoryInfo(categoryName, productName);
  const { Icon } = info;
  return <Icon size={size} className={`${info.iconColorClass} ${className}`} />;
}

export type LiquorCategoryKey =
  | 'ALL'
  | 'WHISKY'
  | 'SCOTCH'
  | 'BEER'
  | 'WINE'
  | 'VODKA'
  | 'RUM'
  | 'GIN'
  | 'BRANDY'
  | 'FOOD'
  | 'OTHER';

export interface CategoryFilterItem {
  id: LiquorCategoryKey;
  label: string;
  emoji: string;
  count: number;
}

export const CATEGORY_DEFINITIONS: { id: LiquorCategoryKey; label: string; emoji: string }[] = [
  { id: 'ALL', label: 'All Items', emoji: '🍹' },
  { id: 'WHISKY', label: 'Whisky', emoji: '🥃' },
  { id: 'SCOTCH', label: 'Scotch', emoji: '🏴󠁧󠁢󠁳󠁣󠁴󠁿' },
  { id: 'BEER', label: 'Beer', emoji: '🍺' },
  { id: 'WINE', label: 'Wine', emoji: '🍷' },
  { id: 'VODKA', label: 'Vodka', emoji: '🍸' },
  { id: 'RUM', label: 'Rum', emoji: '🍹' },
  { id: 'GIN', label: 'Gin', emoji: '🌿' },
  { id: 'BRANDY', label: 'Brandy', emoji: '🍇' },
  { id: 'FOOD', label: 'Food / Kitchen', emoji: '🍽️' },
];

export function classifyProductCategory(p: {
  name?: string | null;
  brand?: string | null;
  categoryName?: string | null;
  menuType?: string | null;
}): LiquorCategoryKey {
  const name = (p.name || '').toLowerCase();
  const brand = (p.brand || '').toLowerCase();
  const cat = (p.categoryName || '').toLowerCase();
  const combined = `${name} ${brand} ${cat}`;

  if (
    p.menuType === 'KITCHEN' ||
    cat.includes('food') ||
    cat.includes('kitchen') ||
    cat.includes('starter') ||
    cat.includes('main course') ||
    cat.includes('snack') ||
    cat.includes('curry') ||
    cat.includes('rice') ||
    cat.includes('biryani') ||
    cat.includes('tandoor') ||
    cat.includes('dessert') ||
    cat.includes('bread') ||
    cat.includes('roti')
  ) {
    return 'FOOD';
  }

  // 1. SCOTCH & SINGLE MALT
  if (
    combined.includes('scotch') ||
    combined.includes('single malt') ||
    combined.includes('chivas') ||
    combined.includes('glenfiddich') ||
    combined.includes('black dog') ||
    combined.includes('red label') ||
    combined.includes('black label') ||
    combined.includes('double black') ||
    combined.includes('gold label') ||
    combined.includes('blue label') ||
    combined.includes('johnnie walker') ||
    combined.includes('glenlivet') ||
    combined.includes('macallan') ||
    combined.includes('ballantine') ||
    combined.includes('100 pipers') ||
    combined.includes('teacher') ||
    combined.includes('vat 69') ||
    combined.includes('j&b') ||
    combined.includes('passport') ||
    combined.includes('bowmore') ||
    combined.includes('talisker') ||
    combined.includes('laphroaig') ||
    combined.includes('lagavulin') ||
    combined.includes('monkey shoulder') ||
    combined.includes('dewar') ||
    combined.includes('grant')
  ) {
    return 'SCOTCH';
  }

  // 2. BEER
  if (
    cat.includes('beer') ||
    combined.includes('beer') ||
    combined.includes('lager') ||
    combined.includes('ale') ||
    combined.includes('pilsner') ||
    combined.includes('stout') ||
    combined.includes('draught') ||
    combined.includes('kingfisher') ||
    combined.includes('budweiser') ||
    combined.includes('carlsberg') ||
    combined.includes('tuborg') ||
    combined.includes('bira') ||
    combined.includes('heineken') ||
    combined.includes('corona') ||
    combined.includes('haywards') ||
    combined.includes('strong beer')
  ) {
    return 'BEER';
  }

  // 3. WINE
  if (
    cat.includes('wine') ||
    combined.includes('wine') ||
    combined.includes('shiraz') ||
    combined.includes('merlot') ||
    combined.includes('cabernet') ||
    combined.includes('sauvignon') ||
    combined.includes('chardonnay') ||
    combined.includes('sula') ||
    combined.includes('jacob') ||
    combined.includes('fratelli') ||
    combined.includes('port wine') ||
    combined.includes('champagne') ||
    combined.includes('prosecco') ||
    combined.includes('chenin') ||
    combined.includes('zinfandel')
  ) {
    return 'WINE';
  }

  // 4. VODKA
  if (
    cat.includes('vodka') ||
    combined.includes('vodka') ||
    combined.includes('magic moments') ||
    combined.includes('smirnoff') ||
    combined.includes('absolut') ||
    combined.includes('grey goose') ||
    combined.includes('romanov') ||
    combined.includes('ketel one') ||
    combined.includes('ciroc') ||
    combined.includes('finlandia') ||
    combined.includes('belvedere')
  ) {
    return 'VODKA';
  }

  // 5. RUM
  if (
    cat.includes('rum') ||
    combined.includes('rum') ||
    combined.includes('old monk') ||
    combined.includes('bacardi') ||
    combined.includes('captain morgan') ||
    combined.includes('havana') ||
    combined.includes('malibu')
  ) {
    return 'RUM';
  }

  // 6. GIN
  if (
    cat.includes('gin') ||
    combined.includes('gin') ||
    combined.includes('blue riband') ||
    combined.includes('bombay sapphire') ||
    combined.includes('tanqueray') ||
    combined.includes('beefeater') ||
    combined.includes('gordon') ||
    combined.includes('greater than') ||
    combined.includes('jaisalmer') ||
    combined.includes('hendrick') ||
    combined.includes('rooku')
  ) {
    return 'GIN';
  }

  // 7. BRANDY
  if (
    cat.includes('brandy') ||
    combined.includes('brandy') ||
    combined.includes('cognac') ||
    combined.includes('mansion house') ||
    combined.includes('honey bee') ||
    combined.includes('morpheus') ||
    combined.includes('courvoisier') ||
    combined.includes('hennessy') ||
    combined.includes('remy martin')
  ) {
    return 'BRANDY';
  }

  // 8. WHISKY (other whiskies)
  if (
    cat.includes('whisky') ||
    cat.includes('whiskey') ||
    combined.includes('whisky') ||
    combined.includes('whiskey') ||
    combined.includes('bourbon') ||
    combined.includes('malt') ||
    combined.includes('blenders pride') ||
    combined.includes('royal stag') ||
    combined.includes('imperial blue') ||
    combined.includes('mcdowell') ||
    combined.includes('signature') ||
    combined.includes('antiquity') ||
    combined.includes('royal challenge') ||
    combined.includes('officer') ||
    combined.includes('8pm') ||
    combined.includes('oaksmith') ||
    combined.includes('sterling reserve') ||
    combined.includes('rockford') ||
    combined.includes('jameson') ||
    combined.includes('jack daniel') ||
    combined.includes('jim beam') ||
    combined.includes('all seasons')
  ) {
    return 'WHISKY';
  }

  if (cat.includes('food') || cat.includes('snack')) {
    return 'FOOD';
  }

  return 'OTHER';
}

