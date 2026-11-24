export function normalize(value: string) {
  return value.trim();
}
export function parse(value: string): string;
export function parse(value: number): string;
export function parse(value: string | number) {
  return String(value);
}
