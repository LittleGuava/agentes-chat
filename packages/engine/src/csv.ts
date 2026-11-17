/** One CSV cell: quoted when it holds a quote, a comma or a line break. */
export const csvCell = (v: string | number) => {
  // A value starting with = + - @ would run as a formula in a spreadsheet: a leading ' keeps it text.
  const s = typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** A CSV file from its lines, the first being the header. */
export const csvOf = (lines: (string | number)[][]) => `${lines.map((l) => l.map(csvCell).join(",")).join("\n")}\n`;
