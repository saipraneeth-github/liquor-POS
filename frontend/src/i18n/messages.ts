/**
 * UI text translations. The key is the English text itself, so `t('Save')` reads naturally and a missing
 * translation simply shows the English. Only interface text (menus, buttons, labels) is translated, never
 * product names, customer names or any data. Add a language: add an entry to LANGUAGES and a dictionary below.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు' },
] as const;

export type LangCode = (typeof LANGUAGES)[number]['code'];
type Dict = Record<string, string>;

const hi: Dict = {
  'Dashboard': 'डैशबोर्ड', 'Billing (POS)': 'बिलिंग (POS)', 'Cashier Shift': 'कैशियर शिफ्ट', 'Bills': 'बिल',
  'Tables & Orders (KOT)': 'टेबल और ऑर्डर (KOT)', 'Customers & Khata': 'ग्राहक और खाता', 'Kitchen Menu': 'किचन मेनू',
  'Bar Menu': 'बार मेनू', 'Products': 'उत्पाद', 'Supplier Invoices': 'सप्लायर इनवॉइस', 'Inventory': 'इन्वेंटरी',
  'Counter Stock Sheet': 'काउंटर स्टॉक शीट', 'Peg Control': 'पेग नियंत्रण', 'Supplier Schemes': 'सप्लायर स्कीम',
  'Excise & Breakage': 'आबकारी और टूट-फूट', 'Accounting': 'लेखा', 'Match Bank Statement': 'बैंक स्टेटमेंट मिलान',
  'Day Closing': 'दिन का समापन', 'Staff & Billing Counters': 'स्टाफ और बिलिंग काउंटर', 'Business Settings': 'व्यवसाय सेटिंग',
  'Platform Console': 'प्लैटफ़ॉर्म कंसोल', 'Roles & Permissions': 'भूमिकाएँ और अनुमतियाँ', 'Branches': 'शाखाएँ',
  'Plans & Billing': 'प्लान और बिलिंग', 'Users': 'उपयोगकर्ता', 'Master Catalog': 'मास्टर कैटलॉग', 'Audit Log': 'ऑडिट लॉग', 'Errors': 'त्रुटियाँ',
  'Overview': 'सारांश', 'Sell': 'बिक्री', 'Menu & Stock': 'मेनू और स्टॉक', 'Money & Compliance': 'पैसा और अनुपालन', 'Business': 'व्यवसाय', 'Platform': 'प्लैटफ़ॉर्म',
  'Sign out': 'साइन आउट', 'Light': 'लाइट', 'Dark': 'डार्क', 'Language': 'भाषा', 'Save': 'सहेजें', 'Cancel': 'रद्द करें', 'Close': 'बंद करें',
  'Search': 'खोजें', 'Delete': 'हटाएँ', 'Edit': 'संपादित करें', 'Add': 'जोड़ें', 'Confirm': 'पुष्टि करें', 'Back': 'वापस', 'Loading…': 'लोड हो रहा है…',
};

const te: Dict = {
  'Dashboard': 'డాష్‌బోర్డ్', 'Billing (POS)': 'బిల్లింగ్ (POS)', 'Cashier Shift': 'క్యాషియర్ షిఫ్ట్', 'Bills': 'బిల్లులు',
  'Tables & Orders (KOT)': 'టేబుళ్లు & ఆర్డర్లు (KOT)', 'Customers & Khata': 'కస్టమర్లు & ఖాతా', 'Kitchen Menu': 'కిచెన్ మెనూ',
  'Bar Menu': 'బార్ మెనూ', 'Products': 'ఉత్పత్తులు', 'Supplier Invoices': 'సరఫరాదారు ఇన్వాయిస్‌లు', 'Inventory': 'ఇన్వెంటరీ',
  'Counter Stock Sheet': 'కౌంటర్ స్టాక్ షీట్', 'Peg Control': 'పెగ్ నియంత్రణ', 'Supplier Schemes': 'సరఫరాదారు స్కీములు',
  'Excise & Breakage': 'ఎక్సైజ్ & బ్రేకేజ్', 'Accounting': 'అకౌంటింగ్', 'Match Bank Statement': 'బ్యాంక్ స్టేట్‌మెంట్ సరిపోల్చండి',
  'Day Closing': 'రోజు ముగింపు', 'Staff & Billing Counters': 'సిబ్బంది & బిల్లింగ్ కౌంటర్లు', 'Business Settings': 'వ్యాపార సెట్టింగ్‌లు',
  'Platform Console': 'ప్లాట్‌ఫామ్ కన్సోల్', 'Roles & Permissions': 'పాత్రలు & అనుమతులు', 'Branches': 'శాఖలు',
  'Plans & Billing': 'ప్లాన్లు & బిల్లింగ్', 'Users': 'వినియోగదారులు', 'Master Catalog': 'మాస్టర్ కేటలాగ్', 'Audit Log': 'ఆడిట్ లాగ్', 'Errors': 'లోపాలు',
  'Overview': 'అవలోకనం', 'Sell': 'అమ్మకాలు', 'Menu & Stock': 'మెనూ & స్టాక్', 'Money & Compliance': 'డబ్బు & సమ్మతి', 'Business': 'వ్యాపారం', 'Platform': 'ప్లాట్‌ఫామ్',
  'Sign out': 'సైన్ అవుట్', 'Light': 'లైట్', 'Dark': 'డార్క్', 'Language': 'భాష', 'Save': 'సేవ్ చేయండి', 'Cancel': 'రద్దు చేయండి', 'Close': 'మూసివేయండి',
  'Search': 'వెతకండి', 'Delete': 'తొలగించండి', 'Edit': 'సవరించండి', 'Add': 'జోడించండి', 'Confirm': 'నిర్ధారించండి', 'Back': 'వెనుకకు', 'Loading…': 'లోడ్ అవుతోంది…',
};

export const MESSAGES: Record<LangCode, Dict> = { en: {}, hi, te };
