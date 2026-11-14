import { useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import { Badge, inr } from '../components/ui';
import { errorMessage } from '../lib/print';
import { isZero, type Account, type ColumnKey, type ColumnMapping, type Preview } from './types';

const FIELD_LABEL: Record<ColumnKey, string> = {
  date: 'Date', valueDate: 'Value date', narration: 'Narration / description', reference: 'Reference / cheque no.',
  debit: 'Debit (money out)', credit: 'Credit (money in)', amount: 'Single Amount column', drCr: 'Dr / Cr indicator', balance: 'Running balance',
};
const FIELD_ORDER: ColumnKey[] = ['date', 'valueDate', 'narration', 'reference', 'debit', 'credit', 'amount', 'drCr', 'balance'];
const colLetter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);

type Settings = {
  mapping: Record<ColumnKey, string>;     // '' = not mapped, otherwise the column index
  headerRow: string;
  dayFirst: 'auto' | 'true' | 'false';
  opening: string;
  closing: string;
};

const emptySettings = (): Settings => ({
  mapping: { date: '', valueDate: '', narration: '', reference: '', debit: '', credit: '', amount: '', drCr: '', balance: '' },
  headerRow: '', dayFirst: 'auto', opening: '', closing: '',
});

const fromMapping = (m: ColumnMapping): Record<ColumnKey, string> => {
  const out = emptySettings().mapping;
  for (const k of FIELD_ORDER) if (m[k] !== undefined) out[k] = String(m[k]);
  return out;
};

export function UploadStatement({ account, onImported, onCancel }: { account: Account; onImported: (statementId: string) => void; onCancel: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sampleRows, setSampleRows] = useState<string[][]>([]);
  const [needsMapping, setNeedsMapping] = useState(false);
  const [settings, setSettings] = useState<Settings>(emptySettings());
  const [acceptMismatch, setAcceptMismatch] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const formFor = (f: File, s: Settings, manual: boolean) => {
    const fd = new FormData();
    fd.append('file', f);
    if (manual) {
      const mapping: Record<string, number> = {};
      for (const k of FIELD_ORDER) if (s.mapping[k] !== '') mapping[k] = Number(s.mapping[k]);
      fd.append('mapping', JSON.stringify(mapping));
      if (s.headerRow !== '') fd.append('headerRow', s.headerRow);
    }
    if (s.dayFirst !== 'auto') fd.append('dayFirst', s.dayFirst);
    if (s.opening.trim()) fd.append('opening', s.opening.trim());
    if (s.closing.trim()) fd.append('closing', s.closing.trim());
    return fd;
  };

  const read = async (f: File, s: Settings, manual: boolean) => {
    setBusy(true);
    setError('');
    try {
      const p = await api.upload<Preview>(`/bank/accounts/${account.id}/statements/preview`, formFor(f, s, manual));
      setPreview(p);
      setSampleRows(p.sampleRows);
      setNeedsMapping(false);
      setSettings((cur) => ({ ...cur, mapping: fromMapping(p.mapping), headerRow: String(p.headerRow) }));
      setAcceptMismatch(false);
    } catch (err) {
      setPreview(null);
      if (err instanceof ApiError && err.data?.details?.code === 'MAPPING_REQUIRED') {
        setSampleRows(err.data.details.sampleRows ?? []);
        setNeedsMapping(true);
        setError(err.message);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const choose = (f: File | null) => {
    setFile(f);
    setPreview(null);
    setNeedsMapping(false);
    setError('');
    setSettings(emptySettings());
    if (f) void read(f, emptySettings(), false);
  };

  const importIt = async () => {
    if (!file || !preview) return;
    setBusy(true);
    setError('');
    try {
      const manual = preview.method === 'MANUAL' || needsMapping;
      const fd = formFor(file, settings, manual);
      if (acceptMismatch) fd.append('acceptBalanceMismatch', 'true');
      const res = await api.upload<{ statement: { id: string }; imported: number; duplicates: number }>(`/bank/accounts/${account.id}/statements`, fd);
      onImported(res.statement.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const width = Math.max(0, ...sampleRows.map((r) => r.length));
  const headerRowIdx = settings.headerRow !== '' && Number(settings.headerRow) >= 0 ? Number(settings.headerRow) : -1;
  const colLabel = (i: number) => {
    const head = headerRowIdx >= 0 ? sampleRows[headerRowIdx]?.[i] : undefined;
    const ex = sampleRows.slice(headerRowIdx + 1).map((r) => r[i]).find((c) => c && c.trim());
    return `${colLetter(i)}${head ? ` · ${head.slice(0, 22)}` : ex ? ` · e.g. ${ex.slice(0, 18)}` : ''}`;
  };
  const bc = preview?.balanceCheck;
  const canImport = Boolean(preview && !preview.alreadyImported && preview.newLines >= 0 && (bc?.status !== 'FAIL' || acceptMismatch));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-bold text-gray-900 dark:text-white">Upload a statement for {account.name}</h3>
        <button type="button" onClick={onCancel} className="text-sm text-gray-500 hover:underline cursor-pointer">Cancel</button>
      </div>

      <div
        className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-6 text-center bg-white dark:bg-gray-800"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); choose(e.dataTransfer.files?.[0] ?? null); }}
      >
        <input
          ref={inputRef} id="bankFile" type="file" className="hidden" accept=".csv,.xlsx,.pdf,.txt,.ofx,.qfx,.qif,text/csv"
          onChange={(e) => { choose(e.target.files?.[0] ?? null); e.target.value = ''; }}
        />
        <p className="text-sm text-gray-700 dark:text-gray-300">Drop your bank statement here, or</p>
        <button type="button" id="bankChooseFile" onClick={() => inputRef.current?.click()} className="mt-2 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-semibold hover:bg-purple-700 cursor-pointer">
          Choose a file
        </button>
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">CSV, Excel (.xlsx), OFX / QFX, QIF or a PDF downloaded from net banking. Any bank — columns are detected automatically. Max 10 MB.</p>
        {file && <p className="mt-2 text-xs font-mono text-gray-600 dark:text-gray-300">{file.name}</p>}
      </div>

      {error && <div id="bankUploadError" role="alert" className="p-3 rounded-lg bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200 text-sm border border-red-200 dark:border-red-800">{error}</div>}
      {busy && <div className="text-sm text-gray-500">Reading the statement…</div>}

      {(preview || needsMapping) && (
        <MappingPanel
          width={width} colLabel={colLabel} settings={settings} setSettings={setSettings}
          detected={preview ? { method: preview.method, confidence: preview.mappingConfidence } : null}
          onApply={() => file && void read(file, settings, true)} open={needsMapping}
        />
      )}

      {preview && bc && (
        <>
          <BalanceBanner check={bc} accept={acceptMismatch} setAccept={setAcceptMismatch} />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Info label="Transactions read" value={String(preview.lineCount)} />
            <Info label="Period" value={preview.periodStart ? `${preview.periodStart} → ${preview.periodEnd}` : '—'} />
            <Info label="Money in / out" value={`${inr(bc.totalCredit)} / ${inr(bc.totalDebit)}`} />
            <Info label="Already imported" value={preview.duplicateLines > 0 ? `${preview.duplicateLines} line(s) will be skipped` : 'none'} />
          </div>
          {preview.alreadyImported && <div className="p-3 rounded-lg bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 text-sm">This exact file has already been imported for this account.</div>}
          {preview.warnings.filter((w) => w !== 'COLUMNS_GUESSED_FROM_CONTENT').map((w) => <Warn key={w} code={w} />)}

          <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800">
            <table className="min-w-full text-xs" id="bankPreviewTable">
              <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-300">
                <tr>{['#', 'Date', 'Narration', 'Reference', 'Debit', 'Credit', 'Balance', ''].map((h) => <th key={h} className="text-left font-semibold px-3 py-2 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={l.lineNo} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="px-3 py-1.5 text-gray-400">{l.lineNo}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{l.txnDate}</td>
                    <td className="px-3 py-1.5 min-w-[14rem] max-w-md whitespace-normal break-words" title={l.narration}>{l.narration}</td>
                    <td className="px-3 py-1.5 font-mono text-gray-500">{l.reference ?? ''}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-red-600 dark:text-red-400">{isZero(l.debit) ? '' : inr(l.debit)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-emerald-600 dark:text-emerald-400">{isZero(l.credit) ? '' : inr(l.credit)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{l.balance === null ? '' : inr(l.balance)}</td>
                    <td className="px-3 py-1.5">{l.flags.includes('DIRECTION_GUESSED') && <Badge tone="warn">direction guessed</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.lineCount > preview.lines.length && <div className="px-3 py-2 text-xs text-gray-500 border-t border-gray-100 dark:border-gray-700">Showing the first {preview.lines.length} of {preview.lineCount}.</div>}
          </div>

          <div>
            <button type="button" onClick={() => setShowRaw((v) => !v)} className="text-xs text-purple-600 dark:text-purple-400 hover:underline cursor-pointer">
              {showRaw ? 'Hide' : 'Show'} the first rows of the file as read
            </button>
            {showRaw && <RawRows rows={sampleRows} />}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" id="bankImportBtn" disabled={!canImport || busy} onClick={() => void importIt()}
              className="px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50 cursor-pointer">
              Import {preview.newLines} transaction{preview.newLines === 1 ? '' : 's'} &amp; match to books
            </button>
            {bc.status === 'FAIL' && !acceptMismatch && <span className="text-xs text-red-600 dark:text-red-400">Fix the problem above, or tick “import anyway”.</span>}
          </div>
        </>
      )}
      {needsMapping && sampleRows.length > 0 && <RawRows rows={sampleRows} />}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="text-[11px] text-gray-500 dark:text-gray-400">{label}</div>
      <div className="font-semibold text-gray-900 dark:text-white break-words">{value}</div>
    </div>
  );
}

function Warn({ code }: { code: string }) {
  const [base] = code.split(':');
  const text: Record<string, string> = {
    OCR_USED: 'Some of this PDF was read with text recognition (OCR). Check the figures carefully, or use the CSV/Excel version.',
    DIRECTION_GUESSED: 'For some lines the statement does not say whether money went in or out, and the balance could not settle it. Those lines are marked “direction guessed”: check them against your statement.',
    NO_BALANCE_COLUMN: 'No running-balance column was found, so the statement cannot be proven correct automatically.',
    NO_NARRATION_COLUMN: 'No narration/description column was found, so matching will rely on amounts and dates only.',
    BOTH_DEBIT_AND_CREDIT_ON_A_LINE: 'Some lines show both a debit and a credit. Check the column mapping.',
    ROWS_WITHOUT_AMOUNT: `${code.split(':')[1] ?? 'Some'} row(s) have a date but no amount we could read, so they were NOT imported. Check the Debit / Credit columns below, or the first rows of the file.`,
    PDF_LINES_SKIPPED: `Some lines in the PDF could not be understood and were skipped (${code.split(':')[1] ?? ''}). The balance check above shows whether anything is missing.`,
  };
  return <div className="p-3 rounded-lg bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 text-sm border border-amber-200 dark:border-amber-800">{text[base] ?? base}</div>;
}

function BalanceBanner({ check, accept, setAccept }: { check: Preview['balanceCheck']; accept: boolean; setAccept: (v: boolean) => void }) {
  const tone = check.status === 'PASS'
    ? 'bg-emerald-50 text-emerald-900 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-800'
    : check.status === 'FAIL'
      ? 'bg-red-50 text-red-900 border-red-300 dark:bg-red-950/40 dark:text-red-200 dark:border-red-800'
      : 'bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800';
  const icon = check.status === 'PASS' ? '✓' : check.status === 'FAIL' ? '✗' : '!';
  return (
    <div id="bankBalanceCheck" data-status={check.status} className={`p-4 rounded-xl border ${tone}`}>
      <div className="font-bold text-sm">{icon} {check.status === 'PASS' ? 'Statement verified' : check.status === 'FAIL' ? 'The statement does not add up' : 'Cannot be verified automatically'}</div>
      <p className="text-sm mt-1">{check.message}</p>
      {check.opening !== null && check.closing !== null && (
        <p className="text-xs mt-2 font-mono">Opening {inr(check.opening)} + credits {inr(check.totalCredit)} − debits {inr(check.totalDebit)} = {check.computedClosing ? inr(check.computedClosing) : '—'} · closing {inr(check.closing)}</p>
      )}
      {check.breaks.length > 0 && (
        <ul className="mt-2 text-xs font-mono space-y-0.5">
          {check.breaks.slice(0, 5).map((b) => <li key={b.lineNo}>Line {b.lineNo}: balance should be {inr(b.expected)}, statement says {inr(b.actual)}</li>)}
          {check.breaks.length > 5 && <li>…and {check.breaks.length - 5} more</li>}
        </ul>
      )}
      {check.status === 'FAIL' && (
        <label className="mt-3 flex items-center gap-2 text-sm cursor-pointer">
          <input id="bankAcceptMismatch" type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          I have checked the problem above and want to import anyway
        </label>
      )}
    </div>
  );
}

function MappingPanel({ width, colLabel, settings, setSettings, detected, onApply, open }: {
  width: number; colLabel: (i: number) => string; settings: Settings; setSettings: (s: Settings) => void;
  detected: { method: string; confidence: number } | null; onApply: () => void; open: boolean;
}) {
  const [show, setShow] = useState(open);
  const visible = show || open;
  const method = detected?.method === 'HEADER' ? 'detected from the column headings' : detected?.method === 'CONTENT' ? 'guessed from what the cells contain' : detected?.method === 'MANUAL' ? 'set by you' : '';
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-gray-700 dark:text-gray-300">
          {detected ? <>Columns <b>{method}</b>. {detected.confidence < 0.7 && <Badge tone="warn">please check</Badge>}</> : <b>Tell us which column is which</b>}
        </div>
        {!open && <button type="button" id="bankToggleMapping" onClick={() => setShow((v) => !v)} className="text-xs text-purple-600 dark:text-purple-400 hover:underline cursor-pointer">{show ? 'Hide' : 'Change'} columns</button>}
      </div>
      {visible && (
        <div className="mt-3 space-y-3">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {FIELD_ORDER.map((k) => (
              <label key={k} className="block text-xs">
                <span className="font-semibold text-gray-700 dark:text-gray-300">{FIELD_LABEL[k]}</span>
                <select
                  id={`bankMap-${k}`} value={settings.mapping[k]}
                  onChange={(e) => setSettings({ ...settings, mapping: { ...settings.mapping, [k]: e.target.value } })}
                  className="mt-1 w-full p-2 border rounded-lg text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                >
                  <option value="">— not in this file —</option>
                  {Array.from({ length: width }, (_, i) => <option key={i} value={String(i)}>{colLabel(i)}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="grid sm:grid-cols-4 gap-3 items-end">
            <label className="block text-xs">
              <span className="font-semibold text-gray-700 dark:text-gray-300">Heading row (0 = first row, −1 = none)</span>
              <input id="bankHeaderRow" type="number" min={-1} max={200} value={settings.headerRow} onChange={(e) => setSettings({ ...settings, headerRow: e.target.value })}
                className="mt-1 w-full p-2 border rounded-lg text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-gray-700 dark:text-gray-300">Date order</span>
              <select id="bankDayFirst" value={settings.dayFirst} onChange={(e) => setSettings({ ...settings, dayFirst: e.target.value as Settings['dayFirst'] })}
                className="mt-1 w-full p-2 border rounded-lg text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                <option value="auto">Detect automatically</option>
                <option value="true">Day / Month / Year</option>
                <option value="false">Month / Day / Year</option>
              </select>
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-gray-700 dark:text-gray-300">Opening balance (if not in the file)</span>
              <input id="bankOpening" inputMode="decimal" value={settings.opening} onChange={(e) => setSettings({ ...settings, opening: e.target.value })} placeholder="0.00"
                className="mt-1 w-full p-2 border rounded-lg text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            </label>
            <label className="block text-xs">
              <span className="font-semibold text-gray-700 dark:text-gray-300">Closing balance (if not in the file)</span>
              <input id="bankClosing" inputMode="decimal" value={settings.closing} onChange={(e) => setSettings({ ...settings, closing: e.target.value })} placeholder="0.00"
                className="mt-1 w-full p-2 border rounded-lg text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
            </label>
          </div>
          <button type="button" id="bankApplyMapping" onClick={onApply} className="px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-semibold hover:bg-purple-700 cursor-pointer">Read the file with these settings</button>
        </div>
      )}
    </div>
  );
}

function RawRows({ rows }: { rows: string[][] }) {
  return (
    <div className="mt-2 overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900">
      <table className="text-[11px] font-mono">
        <tbody>
          {rows.slice(0, 25).map((r, i) => (
            <tr key={i} className="border-b border-gray-100 dark:border-gray-800">
              <td className="px-2 py-1 text-gray-400">{i}</td>
              {r.map((c, j) => <td key={j} className="px-2 py-1 whitespace-nowrap max-w-[14rem] truncate" title={c}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
