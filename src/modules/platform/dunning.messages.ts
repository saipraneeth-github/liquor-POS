// Wording of the billing reminders (pure: no DB).
import { appUrl } from '../../config/integrations.js';
import type { DunningKind } from './dunning.engine.js';

const inr = (v: string) => `Rs ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export function reminderMessage(kind: DunningKind, tenant: string, amount: string | null): { subject: string; text: string } {
  const pay = `Open ${appUrl()}/settings and choose "Pay now".`;
  const due = amount ? ` The invoice is ${inr(amount)}.` : '';
  switch (kind) {
    case 'TRIAL_3': return { subject: `${tenant}: your free trial ends in a few days`, text: `Your trial is about to end. Choose a plan so billing, KOT and reports keep working.\n\n${pay}` };
    case 'TRIAL_ENDED': return { subject: `${tenant}: your free trial has ended`, text: `Your trial has ended and the app is locked until you choose a plan.\n\n${pay}` };
    case 'DUE_7': return { subject: `${tenant}: subscription renews soon`, text: `Your subscription renews within a week.${due}\n\n${pay}` };
    case 'DUE_1': return { subject: `${tenant}: subscription renews tomorrow`, text: `Your subscription runs out tomorrow.${due}\n\n${pay}` };
    case 'OVERDUE': return { subject: `${tenant}: payment overdue`, text: `Your subscription payment is overdue. You can keep working for a few more days.${due}\n\n${pay}` };
    case 'GRACE_LAST': return { subject: `${tenant}: final notice, access is about to be blocked`, text: `This is the last day before access is blocked.${due}\n\n${pay}` };
  }
}

