import { WINDOW } from './model';

export interface WeekRange {
  id: string; start: number; end: number; startDate: string; endDate: string;
  readyAt: number; observed: boolean;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
/** 缓存指定时区的数值日期解析器，避免对每条代码行重新创建。 */
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, value);
  }
  return value;
}
/** 读取时间戳在目标时区的日历字段。 */
function parts(seconds: number, timeZone: string): Record<string, string> {
  return Object.fromEntries(formatter(timeZone).formatToParts(seconds * 1000).map(p => [p.type, p.value]));
}
/** 将时间戳转换为不依赖宿主当前时区的日期键。 */
export function dateKey(seconds: number, timeZone: string): string {
  const p = parts(seconds, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
/** 按日历加减天数，跨夏令时仍保持日期边界。 */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** 求目标时区的午夜；不存在的午夜明确报错，不悄悄使用错误统计边界。 */
export function midnight(date: string, timeZone: string): number {
  const target = Date.parse(`${date}T00:00:00Z`) / 1000;
  if (!Number.isFinite(target)) throw new Error('日期无效');
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const p = parts(guess, timeZone);
    const actual = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
    const delta = target - actual;
    if (!delta) return guess;
    guess += delta;
  }
  throw new Error('该时区的日期边界无法解析，请更换分析时区后重建');
}
/** 截止日期之前 N 个日历天，范围右端不包含截止日。 */
export function daysBefore(cutoff: number, days: number, timeZone: string): number {
  return midnight(shiftDate(dateKey(cutoff, timeZone), -days), timeZone);
}
/** 以周一分组并截断边缘周；整个周段完成 14 天观察后才发布最终比率。 */
export function weekRanges(cutoff: number, days: number, timeZone: string, coverageStart: number): WeekRange[] {
  const first = dateKey(Math.max(daysBefore(cutoff, days, timeZone), coverageStart), timeZone);
  const last = dateKey(cutoff, timeZone);
  const result: WeekRange[] = [];
  let startDate = first;
  while (startDate < last) {
    const weekday = new Date(`${startDate}T12:00:00Z`).getUTCDay();
    const nextMonday = shiftDate(startDate, 7 - (weekday + 6) % 7);
    const endDateExclusive = nextMonday < last ? nextMonday : last;
    const start = midnight(startDate, timeZone), end = midnight(endDateExclusive, timeZone);
    result.push({ id: startDate, startDate, endDate: shiftDate(endDateExclusive, -1),
      start, end, readyAt: end + WINDOW, observed: end + WINDOW <= cutoff });
    startDate = endDateExclusive;
  }
  return result;
}
