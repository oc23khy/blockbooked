export type DisplayedAppointment = {
  startsAt: string;
  status: "confirmed" | "held" | "released";
};

const APPOINTMENT_RANK: Record<DisplayedAppointment["status"], number> = {
  confirmed: 3,
  held: 2,
  released: 1,
};

export function selectDisplayedAppointments(
  rows: { booking_id: string; starts_at: string; status: string }[],
) {
  const selected = new Map<string, DisplayedAppointment>();
  for (const row of rows) {
    if (row.status !== "confirmed" && row.status !== "held" && row.status !== "released") continue;
    const current = selected.get(row.booking_id);
    if (current && APPOINTMENT_RANK[current.status] >= APPOINTMENT_RANK[row.status]) continue;
    selected.set(row.booking_id, { startsAt: row.starts_at, status: row.status });
  }
  return selected;
}

export function historicalAppointmentLabel(input: {
  bookingStatus: string;
  appointmentStatus: string | null;
  hasStart: boolean;
}) {
  if (!input.hasStart) return null;
  if (
    input.appointmentStatus === "released" &&
    (input.bookingStatus === "cancelled" || input.bookingStatus === "declined" || input.bookingStatus === "expired")
  ) {
    return "Former appointment — this time was released.";
  }
  if (input.bookingStatus === "accepted" || input.bookingStatus === "completed") return "Confirmed appointment.";
  if (input.bookingStatus === "pending") {
    return "Held until the provider accepts. A successful payment does not confirm it.";
  }
  if (input.bookingStatus === "expired") return "The acceptance deadline passed and this time was released.";
  return "This time was released.";
}
