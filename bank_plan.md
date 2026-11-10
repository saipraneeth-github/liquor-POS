# Bank Statement Reconciliation: Analysis & Improvement Plan

This document details the analysis of real-world bank statements from `Bank Invoices/` against the platform's bank statement reconciliation engine (`src/modules/bank/bank.engine.ts` and `src/modules/bank/bank.service.ts`), along with the phased remediation plan to ensure 100% automated parsing and balance verification.

---

## 1. Audit Summary of Real Bank Statements (`Bank Invoices/`)

| File Name | Bank & Branch | Outlet / Account | Extracted Txns | Initial Balance Status | Compatibility |
|---|---|---|---|---|---|
| `1789812413693O0TeuxkalBcOxrXU.pdf` | SBI, Bowrampet | Spirit Nation BVG Liquors (`...5702`) | 53 | **PASS** (53/53 tied out) | 100% Out-of-the-Box |
| `1789812483037wV00TyOQhAlZoZBw.pdf` | SBI, Bowrampet | Spirit Nation Sri Aadhya Liquors (`...8208`) | 101 | **PASS** (101/101 tied out) | 100% Out-of-the-Box |
| `1789812571954jPYq8NDWprJqZtSk.pdf` | SBI, Nizampet Road | SVD Liquor Mart (`...4816`) | 47 | **PASS** (47/47 tied out) | 100% Out-of-the-Box |
| `17898126292531iRQhDBGo3cz43Lb.pdf` | SBI, PBB Kukatpally | Sri Balaji Wines (`...6207`) | 71 | **PASS** (71/71 tied out) | 100% Out-of-the-Box |
| `1789812681305HVCQcfZtAFSBW7LF.pdf` | SBI, PBB Kukatpally | Ten Eleven Wines (`...6909`) | 104 | **PASS** (104/104 tied out) | 100% Out-of-the-Box |
| `1792735595704tT8CQEsuFDTEfVyG.pdf` | SBI, Madinaguda | Spirit Nation BYG Wines (`...5994`) | 86 | **PASS** (86/86 tied out) | 100% Out-of-the-Box |
| `1792735595704tT8CQEsuFDTEfVyG (1).pdf` | SBI, Madinaguda | Spirit Nation BYG Wines (`...5994`) | 86 | **PASS** (86/86 tied out) | 100% Out-of-the-Box |
| `4399-4.pdf` | Eenadu Co-op Bank / HDFC | M/S Tirumala Liquor Mart (`1001014004399`) | 142 | **UNVERIFIABLE** (136 skipped) | Needs Improvements |

---

## 2. Issues & Root Causes in Regional / Co-op Bank Statements (`4399-4.pdf`)

### Issue 1: Multi-space column gap before `Cr`/`Dr` marker
- **Root Cause**: `MONEY_AT_END` regex in `bank.engine.ts` used `(?:\s?(?:dr|cr)\b\.?)?` (allowing at most 1 space). When text extraction preserves column spacing as double spaces (e.g. `980294.65  Cr`), the regex fails to match money at the line end, causing valid lines with balances to be discarded.
- **Fix**: Update regex to `(?:\s*(?:dr|cr)\b\.?)?`.

### Issue 2: Date-prefixed Page Carry-Forward Rows (`Balance C/F` / `Balance B/F`)
- **Root Cause**: At each page boundary, lines like `03-10-2026 Balance C/F 2900059.00 2912197.53 23238.80 Cr` start with a date. Because `DATE_AT_START` matches, `textLinesToTable` bypasses the `OPENING_RE` and `CLOSING_RE` noise filters and treats page totals as new transaction rows.
- **Fix**: In `textLinesToTable`, detect `Balance C/F` and `Balance B/F` lines (even if prefixed by a date), extract the carry-forward balance as page checkpoint hints, and do not append them as transactions.

### Issue 3: Standard Indian Banking Prefixes for Direction (`By-` vs `To-`)
- **Root Cause**: In cooperative and regional bank statements, individual credit/debit entries do not always append a `Cr` or `Dr` suffix to the amount. Instead, they use universal Indian banking conventions:
  - `By-` or `By Transfer` = Credit / Money Received (CR)
  - `To-` or `To Transfer` = Debit / Money Paid (DR)
- **Fix**: In `rowsToLines`, when direction is not explicitly indicated by column or suffix, check for `By-` (CR) and `To-` (DR) before falling back to generic keyword guessing.

### Issue 4: Intermittent Balances with Page Checkpoints in `verifyBalanceChain`
- **Root Cause**: The bank statement does not print a running balance on every intra-day transaction, but it prints page-by-page `Balance C/F` and has clear opening and closing balances that tie out down to the paisa. Currently, if `< 50%` of lines have running balances, the engine marks the statement `UNVERIFIABLE`.
- **Fix**: When opening and closing balances are present and intermittent running balances or page carry-forwards are available, compute running balances continuously across lines and verify that the calculated closing equals the stated closing. Upgrade the verification status from `UNVERIFIABLE` to `PASS`.

---

## 3. Implementation Checklist & Verification Results

- [x] **Task 1**: Update `MONEY_AT_END` regex in `src/modules/bank/bank.engine.ts` to allow multiple spaces before Dr/Cr markers (`\s*`).
- [x] **Task 2**: Filter out date-prefixed `Balance C/F` and `Balance B/F` page break rows in `textLinesToTable` while capturing opening and closing hints.
- [x] **Task 3**: Add `By-` (CR) and `To-` (DR) banking prefix detection in direction resolution with high confidence.
- [x] **Task 4**: Support sparse/intermittent running balance verification in `verifyBalanceChain` using continuous balance projection tied to opening/closing and checkpoints.
- [x] **Task 5**: Add comprehensive unit tests in `tests/unit/bank.engine.test.ts` (106 tests passing).
- [x] **Task 6**: Run verification against all 8 actual PDF files in `Bank Invoices/` to confirm 100% PASS rate.

---

## 4. Final Verification Outcome Across All 8 Bank Statements

| File Name | Bank | Outlet | Parsed Txns | Balance Status | Opening Bal | Closing Bal | Checkpoints Verified |
|---|---|---|---|---|---|---|---|
| `1789812413693O0TeuxkalBcOxrXU.pdf` | SBI | Spirit Nation BVG Liquors | 53 | **PASS** | ₹29,46,465.15 | ₹31,73,188.29 | 53/53 |
| `1789812483037wV00TyOQhAlZoZBw.pdf` | SBI | Spirit Nation Sri Aadhya Liquors | 101 | **PASS** | ₹77,935.83 | ₹1,81,513.24 | 101/101 |
| `1789812571954jPYq8NDWprJqZtSk.pdf` | SBI | SVD Liquor Mart | 47 | **PASS** | ₹21,432.00 | ₹8,97,596.85 | 47/47 |
| `17898126292531iRQhDBGo3cz43Lb.pdf` | SBI | Sri Balaji Wines | 71 | **PASS** | ₹1,760.00 | ₹9,442.54 | 71/71 |
| `1789812681305HVCQcfZtAFSBW7LF.pdf` | SBI | Ten Eleven Wines | 104 | **PASS** | ₹3,984.55 | ₹17,29,392.71 | 104/104 |
| `1792735595704tT8CQEsuFDTEfVyG.pdf` | SBI | Spirit Nation BYG Wines | 86 | **PASS** | ₹33,49,112.28 | ₹1,36,621.25 | 86/86 |
| `1792735595704tT8CQEsuFDTEfVyG (1).pdf` | SBI | Spirit Nation BYG Wines | 86 | **PASS** | ₹33,49,112.28 | ₹1,36,621.25 | 86/86 |
| `4399-4.pdf` | Eenadu Co-op Bank | M/S Tirumala Liquor Mart | **151** | **PASS** | ₹11,100.27 | ₹29,39,278.87 | **26 checkpoints (0 breaks, exact to paisa)** |
