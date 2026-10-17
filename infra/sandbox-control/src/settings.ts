/** The same settings, whether or not T3 rewrote the file's formatting or key order. */
export function sameSettings(a: string, b: string): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : value;
  try {
    return JSON.stringify(canonical(JSON.parse(a))) === JSON.stringify(canonical(JSON.parse(b)));
  } catch {
    return false;
  }
}
