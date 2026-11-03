export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED') { super(message); }
}
export function barcode(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!/^(?:\d{8}|\d{12}|\d{13})$/.test(s)) throw new AppError(400, 'הברקוד אינו תקין');
  const digits = [...s].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((total, digit, i) => total + digit * (i % 2 === 0 ? 3 : 1), 0);
  if ((10 - sum % 10) % 10 !== check) throw new AppError(400, 'הברקוד אינו תקין');
  return s;
}
export function price(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(s) || Number(s) <= 0)
    throw new AppError(400, 'יש להזין מחיר גדול מאפס עם עד שתי ספרות אחרי הנקודה');
  return Number(s).toFixed(2);
}
export function safeImage(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const u = new URL(value.trim());
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.port ||
        !u.hostname.includes('.') || /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(u.hostname) ||
        /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) return;
    return u.href;
  } catch { return; }
}
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
