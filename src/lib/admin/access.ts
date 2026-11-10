export function canAccessAdminCenter(role: string | null | undefined) {
  return role === "admin";
}
