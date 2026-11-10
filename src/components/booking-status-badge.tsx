import { bookingStatusLabel, normalizeBookingStatus } from "@/lib/booking-status";

const tones: Record<string, string> = {
  pending: "bg-[#f3e2d4] text-accent-dark",
  accepted: "bg-[#dceee6] text-[#1f6f6a]",
  declined: "bg-[#f8e4dc] text-accent-dark",
  completed: "bg-ink text-white",
  cancelled: "bg-sand text-ink/60",
  expired: "bg-sand text-ink/60",
};

export function BookingStatusBadge({ status }: { status: string }) {
  const normalized = normalizeBookingStatus(status);
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${tones[normalized]}`}>
      {bookingStatusLabel(normalized)}
    </span>
  );
}
