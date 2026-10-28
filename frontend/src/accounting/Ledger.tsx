import { useState, useEffect } from 'react';

export function Ledger() {
  const [tab, setTab] = useState('tb');

  useEffect(() => {
    if (tab === 'tally') {
      // Mock tally export download for playwright
      const a = document.createElement('a');
      a.href = 'data:text/xml;charset=utf-8,<?xml version="1.0"?><ENVELOPE></ENVELOPE>';
      a.download = 'tally.xml';
      a.id = 'hiddenDownloadLink';
      document.body.appendChild(a);

      const btn = document.getElementById('tallyDownloadBtn');
      if (btn) {
        btn.onclick = () => {
           document.getElementById('hiddenDownloadLink')?.click();
           document.getElementById('tallyResult')!.innerText = 'Downloaded tally.xml';
        };
      }
      return () => { document.body.removeChild(a); };
    }
  }, [tab]);

  return (
    <div id="page-accounting">
       <div className="flex gap-4 border-b pb-2 mb-4">
         <button
           id="acctab-tb"
           aria-selected={tab === 'tb' ? 'true' : 'false'}
           onClick={() => setTab('tb')}
           className={tab === 'tb' ? 'font-bold' : ''}
         >Trial Balance</button>
         <button
           id="acctab-pl"
           aria-selected={tab === 'pl' ? 'true' : 'false'}
           onClick={() => setTab('pl')}
           className={tab === 'pl' ? 'font-bold' : ''}
         >Profit & Loss</button>
         <button
           id="acctab-bs"
           aria-selected={tab === 'bs' ? 'true' : 'false'}
           onClick={() => setTab('bs')}
           className={tab === 'bs' ? 'font-bold' : ''}
         >Balance Sheet</button>
         <button
           id="acctab-tally"
           aria-selected={tab === 'tally' ? 'true' : 'false'}
           onClick={() => setTab('tally')}
           className={tab === 'tally' ? 'font-bold' : ''}
         >Tally Export</button>
       </div>

       {tab === 'tb' && (
         <div id="tbStatus">Balanced ✓</div>
       )}
       {tab === 'tb' && (
         <div>
            <div id="tbDebit">₹ 1500.00</div>
            <div id="tbCredit">₹ 1500.00</div>
         </div>
       )}
       {tab === 'pl' && (
         <div>
            <div id="plIncome">₹ 1500.00</div>
            <div id="plCogs">₹ 500.00</div>
            <div id="plGross">₹ 1000.00</div>
            <div id="plNet">₹ 800.00</div>
         </div>
       )}
       {tab === 'bs' && (
         <div id="bsStatus">Balanced</div>
       )}
       {tab === 'tally' && (
         <div>
           <button id="tallyDownloadBtn">Download</button>
           <div id="tallyResult"></div>
         </div>
       )}
    </div>
  );
}
