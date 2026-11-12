"use client";

import { useActionState, useState } from "react";
import { reviewOutreachImport, type OutreachPreviewState } from "@/app/actions/outreach";

const initialState: OutreachPreviewState = { message: "", rows: [] };

export function OutreachImporter() {
  const [csv, setCsv] = useState("");
  const [fileNote, setFileNote] = useState("");
  const [state, action, pending] = useActionState(reviewOutreachImport, initialState);
  const counts = state.rows.reduce(
    (total, row) => {
      total[row.outcome] += 1;
      return total;
    },
    { ready: 0, duplicate: 0, suppressed: 0, invalid: 0 },
  );

  return (
    <form action={action} className="rounded-3xl border border-line bg-card p-4">
      <h2 className="font-serif text-2xl text-ink">Import CSV</h2>
      <p className="mt-1 text-sm leading-6 text-ink/70">
        Columns: business_name, category, location, website, contact_email, source, lead_status. Preview checks duplicates and opted-out emails before anything is saved.
      </p>
      <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink/50">
        CSV file
        <input
          type="file"
          accept=".csv,text/csv"
          className="mt-1 block w-full text-sm"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 200_000) {
              setFileNote("That file is larger than 200 KB.");
              return;
            }
            setFileNote("");
            file.text().then(setCsv).catch(() => setFileNote("That file could not be read."));
          }}
        />
      </label>
      {fileNote ? <p className="mt-2 text-sm font-medium text-accent-dark">{fileNote}</p> : null}
      <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-ink/50">
        CSV text
        <textarea
          name="csv"
          value={csv}
          onChange={(event) => setCsv(event.target.value)}
          required
          maxLength={200_000}
          rows={5}
          spellCheck={false}
          className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2 font-mono text-xs outline-none focus:border-ink"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button name="intent" value="preview" disabled={pending} className="rounded-full border border-ink px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50">
          Preview
        </button>
        {counts.ready > 0 ? (
          <button name="intent" value="import" disabled={pending} className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Import {counts.ready} ready
          </button>
        ) : null}
      </div>
      {state.message ? <p className="mt-3 text-sm font-medium text-accent-dark">{state.message}</p> : null}
      {state.rows.length > 0 ? (
        <>
          <p className="mt-3 text-sm text-ink/70">
            Ready {counts.ready} · duplicates {counts.duplicate} · opted out {counts.suppressed} · invalid {counts.invalid}
          </p>
          <div className="mt-3 max-h-80 overflow-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-ink/50">
                <tr>
                  <th className="py-2 pr-3 font-semibold">Result</th>
                  <th className="py-2 pr-3 font-semibold">Business</th>
                  <th className="py-2 pr-3 font-semibold">Email</th>
                  <th className="py-2 font-semibold">Reason</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((row) => (
                  <tr key={`${row.line}-${row.duplicateKey}`} className="border-t border-line align-top">
                    <td className="py-2 pr-3 font-semibold text-ink">{row.outcome}</td>
                    <td className="py-2 pr-3 text-ink">{row.businessName || "Missing name"}</td>
                    <td className="py-2 pr-3 text-ink/70">{row.contactEmail || "—"}</td>
                    <td className="py-2 text-ink/70">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </form>
  );
}
