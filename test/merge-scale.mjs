// merge-scale — conflict twins stay linear (Stage 2, 1.87). Deterministic twin
// ids mean every conflict looks for an existing twin before minting one; done
// naively that is a scan per conflict, quadratic in a brain with thousands of
// simultaneous conflicts (two machines that re-saved every card). The engine
// keeps one index per merge instead. This pins it two ways: the Stage 2 merge
// stays within 1.5x of the 1.86.3 engine on the same many-conflict merge, and
// doubling the conflicts roughly doubles the time.
//
// Measured on 3,000 conflicts while writing this: 1.86.3 5.6-5.8 s, 1.87 union
// 5.1-5.4 s, 1.87 3-way 5.4-5.9 s. The committed size is smaller to keep the
// suite fast; a quadratic index shows at this size already.
//
// Run:  node test/merge-scale.mjs        (exit 0 = pass, 1 = fail)
import { buildKlypix, parseKlypix, shard } from '../src/klypix-format.mjs';
import { mergeBrains } from '../src/merge-brains.mjs';
import * as OLD from './fixtures/engine-1.86.3/merge-brains.mjs';

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '[ok]' : '[x]'} ${label}`); if (!cond) failures++; };
const OPTS = { binMerge: '3way', newOnBothSides: 'twin', manifestMerge: '3way', adoptResolvedConflicts: true };

async function conflicted(n) {
    const base = await buildKlypix({ title: 'scale', cards: Array.from({ length: n }, (_, i) => ({ id: `txt_c${i}`, text: `card ${i} as it was` })) });
    const editAll = async (tag) => {
        const { zip } = await parseKlypix(base);
        for (let i = 0; i < n; i++) {
            const p = `items/${shard(`txt_c${i}`)}/txt_c${i}.json`;
            zip.file(p, JSON.stringify({ ...JSON.parse(await zip.file(p).async('string')), content: `card ${i} edited on ${tag}` }));
        }
        return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    };
    return { base, ours: await editAll('ours'), theirs: await editAll('theirs') };
}
const timed = async (fn) => { const t = performance.now(); const r = await fn(); return { ms: performance.now() - t, r }; };
// Best of two: the least-disturbed run is the fair comparison on a busy machine.
const best = async (fn) => { const a = await timed(fn); const b = await timed(fn); return a.ms <= b.ms ? a : b; };

const N = 1200;
const big = await conflicted(N);
const old = await best(() => OLD.mergeBrains(big));
const now = await best(() => mergeBrains({ ...big, options: OPTS }));
ok(old.r.conflicts.length === N && now.r.conflicts.length === N, `fixture: ${N} simultaneous conflicts, each twinned by both engines`);
ok(now.ms <= 1.5 * old.ms,
    `a ${N}-conflict merge stays within 1.5x of 1.86.3 (1.87 3-way ${now.ms.toFixed(0)} ms, 1.86.3 ${old.ms.toFixed(0)} ms, x${(now.ms / old.ms).toFixed(2)})`);

const small = await conflicted(N / 2);
const half = await best(() => mergeBrains({ ...small, options: OPTS }));
const growth = now.ms / half.ms;
ok(growth <= 3, `doubling the conflicts about doubles the time (x${growth.toFixed(2)}; a scan per conflict would be ~x4)`);

console.log(failures ? `\n[x] ${failures} assertion(s) failed` : '\n[ok] merge-scale: all assertions passed');
process.exit(failures ? 1 : 0);
