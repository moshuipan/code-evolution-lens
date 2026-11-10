import { Fixture, CONFIG, DAY, T, AI } from './fixtures';
import { replay } from '../src/replay';
import { TrendQuery } from '../src/trends';

/** 创建可复现的真实 Git 历史，用于浏览器展示趋势和下钻，不作为宿主验收。 */
export async function previewQuery(): Promise<TrendQuery> {
  const fixture = await Fixture.create();
  try {
    await fixture.write('README.md', 'older than the analysis range\n'); fixture.commit(T - 200 * DAY);
    for (let week = 0; week < 12; week++) {
      const days = 85 - week * 7;
      const ai = Array.from({ length: 80 }, (_, i) => `export const item${i} = ${i};\n`);
      const human = Array.from({ length: 60 }, (_, i) => `export const value${i} = ${i};\n`);
      const module = week % 2 ? 'client' : 'server';
      await fixture.write(`src/${module}/week-${week + 1}.ts`, ai.join(''));
      fixture.commit(T - days * DAY, `Add module\n\n${AI}`);
      await fixture.write(`src/${module}/helpers-${week + 1}.ts`, human.join(''));
      fixture.commit(T - days * DAY + 60);
      if (days < 3) continue;
      const aiChanges = [24, 20, 28, 16, 22, 12, 18, 10, 16, 8, 12, 6][week];
      const humanChanges = [8, 6, 10, 7, 9, 6, 8, 5, 7, 4, 6, 4][week];
      await fixture.write(`src/${module}/week-${week + 1}.ts`, ai.map((line, i) => i < aiChanges ? `export const item${i} = ${i + 100};\n` : line).join(''));
      await fixture.write(`src/${module}/helpers-${week + 1}.ts`, human.map((line, i) => i < humanChanges ? `export const value${i} = ${i + 100};\n` : line).join(''));
      fixture.commit(T - (days - 3) * DAY, 'Refine modules');
    }
    const snapshot = await replay(fixture.root, CONFIG, { cutoff: T, now: T + DAY });
    return new TrendQuery({ ...snapshot, timeZone: 'UTC' });
  } finally { await fixture.dispose(); }
}
