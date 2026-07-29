/* Конвертации — чистые функции, без I/O и без DOM.
   Единицы (длина/масса/объём/площадь/скорость/время/данные/угол),
   температура (нелинейная), системы счисления (hex/bin/oct/dec).
   Валюты живут в main.ts (нужен сетевой fetch + перерисовка), здесь только
   набор ISO-кодов CURRENCIES, чтобы парсер отличал «usd» от «kg». */

/* ---- Линейные единицы: value_base = amount * factor; amount = base / factor.
   Кросс-размерные конверсии отклоняются (разные группы). ---- */
type Factors = Record<string, number>;
const DIMS: Record<string, Factors> = {
  length: { m: 1, mm: 0.001, cm: 0.01, dm: 0.1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852 },
  mass: { kg: 1, mg: 1e-6, g: 0.001, t: 1000, oz: 0.028349523125, lb: 0.45359237, st: 6.35029318 },
  volume: { l: 1, ml: 0.001, cl: 0.01, dl: 0.1, m3: 1000, floz: 0.0295735295625, cup: 0.2365882365, pt: 0.473176473, qt: 0.946352946, gal: 3.785411784, tsp: 0.00492892159375, tbsp: 0.01478676478125 },
  area: { m2: 1, cm2: 0.0001, km2: 1e6, ha: 1e4, ft2: 0.09290304, yd2: 0.83612736, ac: 4046.8564224, mi2: 2589988.110336 },
  speed: { mps: 1, kmh: 1 / 3.6, mph: 0.44704, kn: 1852 / 3600, fts: 0.3048 },
  time: { s: 1, ms: 0.001, min: 60, h: 3600, day: 86400, week: 604800, month: 2629800, year: 31557600 },
  // Данные: двоичные степени (как Проводник Windows показывает размеры файлов).
  data: { byte: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776, bit: 1 / 8 },
  angle: { rad: 1, deg: Math.PI / 180, grad: Math.PI / 200 },
};

/* Псевдонимы (полные имена, множественное число, символы) -> канон-токен. */
const ALIAS: Record<string, string> = {
  // длина
  meter: "m", meters: "m", metre: "m", metres: "m",
  millimeter: "mm", millimeters: "mm", millimetre: "mm", millimetres: "mm",
  centimeter: "cm", centimeters: "cm", centimetre: "cm", centimetres: "cm",
  kilometer: "km", kilometers: "km", kilometre: "km", kilometres: "km",
  inch: "in", inches: "in", '"': "in", foot: "ft", feet: "ft",
  yard: "yd", yards: "yd", mile: "mi", miles: "mi", nauticalmile: "nmi",
  // масса
  kilogram: "kg", kilograms: "kg", kilo: "kg", kgs: "kg",
  gram: "g", grams: "g", milligram: "mg", milligrams: "mg",
  tonne: "t", tonnes: "t", ton: "t", ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb", lb: "lb", lbs: "lb", stone: "st",
  // объём
  liter: "l", liters: "l", litre: "l", litres: "l",
  milliliter: "ml", milliliters: "ml", millilitre: "ml",
  gallon: "gal", gallons: "gal", pint: "pt", pints: "pt",
  quart: "qt", quarts: "qt", cups: "cup", tablespoon: "tbsp", tablespoons: "tbsp",
  teaspoon: "tsp", teaspoons: "tsp", floz: "floz", fluidounce: "floz",
  // площадь
  hectare: "ha", hectares: "ha", acre: "ac", acres: "ac",
  // скорость
  kph: "kmh", knot: "kn", knots: "kn",
  // данные
  bytes: "byte", b: "byte", kib: "kb", kilobyte: "kb", kilobytes: "kb",
  mib: "mb", megabyte: "mb", megabytes: "mb", gib: "gb", gigabyte: "gb", gigabytes: "gb",
  tib: "tb", terabyte: "tb", terabytes: "tb", bits: "bit",
  // угол
  degree: "deg", degrees: "deg", "°": "deg", radian: "rad", radians: "rad", gradian: "grad",
  // время
  second: "s", seconds: "s", sec: "s", secs: "s",
  minute: "min", minutes: "min", mins: "min", hour: "h", hours: "h", hr: "h", hrs: "h",
  days: "day", weeks: "week", months: "month", years: "year",
};

/* Слитные символы скорости, которые нельзя разбить в токен (со слэшем/точкой). */
const SLASH_ALIAS: Record<string, string> = {
  "km/h": "kmh", "mi/h": "mph", "m/s": "mps", "ft/s": "fts", "fl oz": "floz",
};

/* Температура — отдельно (нелинейная): канон c/f/k. */
const TEMP: Record<string, "c" | "f" | "k"> = {
  c: "c", "°c": "c", celsius: "c", centigrade: "c",
  f: "f", "°f": "f", fahrenheit: "f",
  k: "k", "°k": "k", kelvin: "k",
};

/** Канонизировать токен единицы (нижний регистр уже ожидается). */
function canon(tok: string): string {
  return SLASH_ALIAS[tok] ?? ALIAS[tok] ?? tok;
}

/** Множество всех известных токенов единиц (для детекта «это единица?»). */
export const UNIT_TOKENS: Set<string> = new Set([
  ...Object.values(DIMS).flatMap((f) => Object.keys(f)),
  ...Object.keys(ALIAS),
  ...Object.keys(SLASH_ALIAS),
  ...Object.keys(TEMP),
]);

/** ISO-коды валют — парсер отдаёт их в валютную ветку (сеть) main.ts. */
export const CURRENCIES: Set<string> = new Set([
  "usd", "eur", "rub", "gbp", "jpy", "cny", "chf", "cad", "aud", "nzd",
  "sek", "nok", "dkk", "pln", "czk", "huf", "ron", "try", "uah", "byn",
  "kzt", "inr", "brl", "mxn", "zar", "krw", "sgd", "hkd", "twd", "thb",
  "idr", "myr", "php", "vnd", "aed", "sar", "ils", "ngn", "egp", "clp",
  "cop", "ars", "bgn", "hrk", "isk", "gel", "amd", "azn", "uzs", "qar",
]);

export interface UnitResult {
  n: number;
  unit: string; // канон-символ цели для показа
  cat: "length" | "mass" | "volume" | "area" | "speed" | "time" | "data" | "angle" | "temp";
}

/** Конверсия amount из from в to. null — неизвестные единицы или разные группы. */
export function convertUnits(amount: number, from: string, to: string): UnitResult | null {
  const f = from.toLowerCase();
  const tt = to.toLowerCase();

  // Температура: обе стороны должны быть градусами.
  if (TEMP[f] && TEMP[tt]) {
    const c = TEMP[f] === "c" ? amount : TEMP[f] === "f" ? (amount - 32) * 5 / 9 : amount - 273.15;
    const out = TEMP[tt] === "c" ? c : TEMP[tt] === "f" ? c * 9 / 5 + 32 : c + 273.15;
    return { n: out, unit: "°" + TEMP[tt].toUpperCase(), cat: "temp" };
  }
  if (TEMP[f] || TEMP[tt]) return null; // градус <-> не-градус

  const cf = canon(f);
  const ct = canon(tt);
  for (const [cat, fac] of Object.entries(DIMS)) {
    if (fac[cf] != null && fac[ct] != null) {
      return { n: (amount * fac[cf]) / fac[ct], unit: ct, cat: cat as UnitResult["cat"] };
    }
  }
  return null;
}

/** Формат числа: больше величина — меньше знаков после точки; тысячные разделители. */
export function fmtNum(v: number): string {
  if (!isFinite(v)) return "∞";
  const abs = Math.abs(v);
  const d = abs >= 100 ? 2 : abs >= 1 ? 4 : abs === 0 ? 0 : 6;
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return r.toLocaleString("en-US", { maximumFractionDigits: d });
}

/* ---- Системы счисления ---- */

/** Разобрать целочисленный литерал: 0x.. / 0b.. / 0o.. / десятичный. null — не число.
   Знак снимаем вручную: BigInt("-0x1F") кидает (нет знака в non-decimal грамматике). */
export function parseIntLiteral(tok: string): bigint | null {
  let s = tok.toLowerCase().replace(/[_\s]/g, "");
  let neg = false;
  if (s.startsWith("-")) { neg = true; s = s.slice(1); }
  else if (s.startsWith("+")) s = s.slice(1);
  if (!/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)$/.test(s)) return null;
  try {
    const v = BigInt(s);
    return neg ? -v : v;
  } catch {
    return null;
  }
}

/** Представить целое в целевой системе. base: hex|bin|oct|dec. */
export function toBase(v: bigint, base: "hex" | "bin" | "oct" | "dec"): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const body =
    base === "hex" ? "0x" + a.toString(16).toUpperCase() :
    base === "bin" ? "0b" + a.toString(2) :
    base === "oct" ? "0o" + a.toString(8) :
    a.toString(10);
  return (neg ? "-" : "") + body;
}
