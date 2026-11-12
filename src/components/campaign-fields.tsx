import { leadStatusLabel, leadStatuses } from "@/lib/outreach/prospects";

export type CampaignFieldValues = {
  name: string;
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  physicalAddress: string;
  unsubscribeFooter: string;
  leadStatus: string;
  category: string;
  location: string;
  source: string;
};

const fieldClass = "w-full rounded-xl border border-line bg-sand px-3 py-2 text-sm outline-none focus:border-ink";

export function CampaignFields({ values }: { values: CampaignFieldValues }) {
  return (
    <div className="grid gap-3">
      <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
        Campaign name
        <input name="name" required maxLength={120} defaultValue={values.name} className={`mt-1 ${fieldClass}`} />
      </label>
      <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
        Subject
        <input name="subject" required maxLength={160} defaultValue={values.subject} className={`mt-1 ${fieldClass}`} />
      </label>
      <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
        Body
        <textarea name="body" required maxLength={8000} rows={8} defaultValue={values.body} className={`mt-1 ${fieldClass}`} />
      </label>
      <p className="text-xs leading-5 text-ink/60">Personalization: {"{{business_name}}"} and {"{{city}}"}.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
          Status filter
          <select name="leadStatus" defaultValue={values.leadStatus} className={`mt-1 ${fieldClass}`}>
            <option value="">Any except suppressed</option>
            {leadStatuses.filter((status) => status !== "suppressed").map((status) => (
              <option key={status} value={status}>{leadStatusLabel(status)}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
          Category contains
          <input name="category" maxLength={80} defaultValue={values.category} className={`mt-1 ${fieldClass}`} />
        </label>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
          City contains
          <input name="location" maxLength={120} defaultValue={values.location} className={`mt-1 ${fieldClass}`} />
        </label>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
          Source contains
          <input name="source" maxLength={80} defaultValue={values.source} className={`mt-1 ${fieldClass}`} />
        </label>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
          Sender name
          <input name="senderName" maxLength={80} defaultValue={values.senderName} className={`mt-1 ${fieldClass}`} />
        </label>
        <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
          Sender email
          <input name="senderEmail" type="email" maxLength={320} defaultValue={values.senderEmail} className={`mt-1 ${fieldClass}`} />
        </label>
      </div>
      <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
        Physical mailing address
        <input name="physicalAddress" maxLength={300} defaultValue={values.physicalAddress} className={`mt-1 ${fieldClass}`} />
      </label>
      <label className="text-xs font-semibold uppercase tracking-wide text-ink/50">
        Unsubscribe footer
        <textarea name="unsubscribeFooter" maxLength={500} rows={3} defaultValue={values.unsubscribeFooter} className={`mt-1 ${fieldClass}`} />
      </label>
    </div>
  );
}
