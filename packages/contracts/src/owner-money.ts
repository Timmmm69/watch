/** Parse decimal rubles exactly; reject extra decimal places rather than round silently. */
export function rublesToMinor(value: string): number {
  const normalized = value
    .trim()
    .replaceAll("\u00a0", " ")
    .replaceAll(" ", "")
    .replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized))
    throw new Error(
      "Укажите цену в рублях: например 199,90. Не больше двух цифр после запятой.",
    );
  const [rubles, cents = ""] = normalized.split(".");
  const result = BigInt(rubles!) * 100n + BigInt(cents.padEnd(2, "0"));
  if (result > 2000000000n) throw new Error("Цена слишком большая.");
  return Number(result);
}
export const minorToRubles = (value: number) =>
  `${Math.floor(value / 100)},${String(value % 100).padStart(2, "0")}`;
