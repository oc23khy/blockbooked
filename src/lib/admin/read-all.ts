export async function readAllPages<T extends { id: string }>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
) {
  const rows: T[] = [];
  const seen = new Set<string>();
  let from = 0;
  for (let page = 0; page < 100; page += 1) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) return { rows: [] as T[], error: error.message, truncated: true };
    const batch = data ?? [];
    if (batch.length === 0) return { rows, error: null, truncated: false };
    for (const row of batch) {
      if (seen.has(row.id)) {
        return {
          rows: [] as T[],
          error: "The database read repeated a page, so financial totals were not calculated.",
          truncated: true,
        };
      }
      seen.add(row.id);
    }
    rows.push(...batch);
    if (batch.length < pageSize) return { rows, error: null, truncated: false };
    from += batch.length;
  }
  return {
    rows: [] as T[],
    error: "Financial totals exceed the paged read limit and were not calculated.",
    truncated: true,
  };
}
