import {
  addTimeOff,
  removeTimeOff,
  saveBusinessHours,
  saveScheduleSettings,
  uploadProviderImage,
} from "@/app/actions/schedule";
import { CatalogServicesForm } from "@/components/catalog-services-form";
import { mediaUrl } from "@/lib/scheduling/public";

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type HourRow = { weekday: number; opens_minute: number; closes_minute: number };
type ServiceRow = {
  id: string;
  name: string;
  description: string;
  pricing_type: string;
  price_cents: number | null;
  duration_minutes: number | null;
  active: boolean;
};
type TimeOffRow = { id: string; starts_at: string; ends_at: string; note: string };
type Settings = { min_notice_minutes: number; max_advance_days: number; buffer_minutes: number } | null;

function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function ScheduleManager({
  hours,
  services,
  settings,
  timeOff,
  images,
  timeZone,
}: {
  hours: HourRow[];
  services: ServiceRow[];
  settings: Settings;
  timeOff: TimeOffRow[];
  images: { storage_path: string; caption: string }[];
  timeZone: string;
}) {
  return (
    <section className="grid gap-4">
      <form action={saveScheduleSettings} className="rounded-3xl border border-line bg-card p-6">
        <h2 className="font-serif text-3xl text-ink">Booking rules</h2>
        <p className="mt-2 text-sm leading-6 text-ink/70">
          Times use {timeZone}. Customers only see openings that fit these rules. A pending request holds its time until you accept, decline, or the customer cancels.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-sm font-medium text-ink">
            Minimum notice (hours)
            <input name="noticeHours" type="number" min="0" max="168" defaultValue={Math.round((settings?.min_notice_minutes ?? 120) / 60)} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5" />
          </label>
          <label className="text-sm font-medium text-ink">
            Book up to (days)
            <input name="advanceDays" type="number" min="1" max="365" defaultValue={settings?.max_advance_days ?? 60} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5" />
          </label>
          <label className="text-sm font-medium text-ink">
            Buffer after each visit (minutes)
            <input name="bufferMinutes" type="number" min="0" max="240" defaultValue={settings?.buffer_minutes ?? 0} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5" />
          </label>
        </div>
        <button className="mt-4 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white">Save booking rules</button>
      </form>

      <form action={saveBusinessHours} className="rounded-3xl border border-line bg-card p-6">
        <h2 className="font-serif text-3xl text-ink">Weekly hours</h2>
        <p className="mt-2 text-sm leading-6 text-ink/70">Leave a day blank to stay closed. A break splits the day into two bookable windows.</p>
        <div className="mt-4 grid gap-3">
          {weekdays.map((day, weekday) => {
            const windows = hours.filter((hour) => hour.weekday === weekday).sort((a, b) => a.opens_minute - b.opens_minute);
            const open = windows[0]?.opens_minute;
            const close = windows.length > 1 ? windows[1].closes_minute : windows[0]?.closes_minute;
            const breakStart = windows.length > 1 ? windows[0].closes_minute : undefined;
            const breakEnd = windows.length > 1 ? windows[1].opens_minute : undefined;
            return (
              <div key={day} className="grid gap-2 rounded-2xl border border-line p-3 sm:grid-cols-5 sm:items-end">
                <p className="text-sm font-semibold text-ink">{day}</p>
                <TimeField label="Opens" name={`open-${weekday}`} defaultValue={open == null ? "" : clock(open)} />
                <TimeField label="Closes" name={`close-${weekday}`} defaultValue={close == null ? "" : clock(close)} />
                <TimeField label="Break starts" name={`break-start-${weekday}`} defaultValue={breakStart == null ? "" : clock(breakStart)} />
                <TimeField label="Break ends" name={`break-end-${weekday}`} defaultValue={breakEnd == null ? "" : clock(breakEnd)} />
              </div>
            );
          })}
        </div>
        <button className="mt-4 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white">Save weekly hours</button>
      </form>

      <CatalogServicesForm services={services} />

      <div className="rounded-3xl border border-line bg-card p-6">
        <h2 className="font-serif text-3xl text-ink">Days off and blocked times</h2>
        <form action={addTimeOff} className="mt-4 grid gap-3 sm:grid-cols-2">
          <TimeField label="Starts on" name="startDate" type="date" />
          <TimeField label="Start time" name="startTime" />
          <TimeField label="Ends on" name="endDate" type="date" />
          <TimeField label="End time" name="endTime" />
          <label className="text-sm font-medium text-ink sm:col-span-2">
            Private note
            <input name="note" maxLength={80} placeholder="Visible only to you" className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5" />
          </label>
          <button className="rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white sm:col-span-2">Block this time</button>
        </form>
        <ul className="mt-4 grid gap-2">
          {timeOff.map((block) => (
            <li key={block.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-sand px-3 py-2 text-sm">
              <span>{new Date(block.starts_at).toLocaleString("en-US", { timeZone })} – {new Date(block.ends_at).toLocaleString("en-US", { timeZone })}{block.note ? ` · ${block.note}` : ""}</span>
              <form action={removeTimeOff}>
                <input type="hidden" name="timeOffId" value={block.id} />
                <button className="rounded-full border border-line px-3 py-1.5">Remove</button>
              </form>
            </li>
          ))}
          {timeOff.length === 0 ? <li className="text-sm text-ink/70">No blocked times.</li> : null}
        </ul>
      </div>

      <form action={uploadProviderImage} className="rounded-3xl border border-line bg-card p-6">
        <h2 className="font-serif text-3xl text-ink">Photos</h2>
        <p className="mt-2 text-sm leading-6 text-ink/70">JPEG, PNG, or WebP, up to 5 MB. These photos are public on your profile.</p>
        <div className="mt-4 grid gap-3">
          <input name="image" type="file" accept="image/jpeg,image/png,image/webp" required className="text-sm" />
          <input name="caption" placeholder="Caption" className="rounded-xl border border-line bg-sand px-3 py-2.5 text-sm" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="cover" value="yes" />
            Use this photo as the cover
          </label>
          <button className="w-fit rounded-full bg-accent px-4 py-3 text-sm font-semibold text-white">Upload photo</button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {images.map((image) => (
            <figure key={image.storage_path}>
              <img src={mediaUrl(image.storage_path) ?? ""} alt={image.caption || "Provider photo"} className="aspect-square w-full rounded-2xl object-cover" />
              {image.caption ? <figcaption className="mt-1 text-xs text-ink/70">{image.caption}</figcaption> : null}
            </figure>
          ))}
        </div>
      </form>
    </section>
  );
}

function TimeField({ label, name, defaultValue = "", type = "time" }: { label: string; name: string; defaultValue?: string; type?: string }) {
  return (
    <label className="text-sm font-medium text-ink">
      {label}
      <input name={name} type={type} defaultValue={defaultValue} className="mt-1 w-full rounded-xl border border-line bg-sand px-3 py-2.5" />
    </label>
  );
}
