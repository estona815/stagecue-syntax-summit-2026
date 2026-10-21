const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const parser = code.slice(code.indexOf('function issue('), code.indexOf('function cueAt('));
assert.ok(parser.includes('function parse('));
const parse = vm.runInNewContext(parser + '\nparse;');
function script(aStart, aDuration, bStart, bDuration) {
  return 'show "Overlap test"\nlength 90s\ncue "A" at '+aStart+'s for '+aDuration+'s\nend\ncue "B" at '+bStart+'s for '+bDuration+'s\nend';
}
function warnings(text) { return parse(text).issues.filter(x=>x.type === 'warning'); }
test('short cue contained in a long cue overlaps only for its own duration', () => {
  const w=warnings(script(0,60,10,5)); assert.equal(w.length,1); assert.equal(w[0].message,'“B” overlaps “A” by 5s.');
});
test('partial overlap retains the actual intersection length', () => {
  const w=warnings(script(0,20,16,10)); assert.equal(w.length,1); assert.equal(w[0].message,'“B” overlaps “A” by 4s.');
});
test('same-start and same-end cues use the shorter intersection', () => {
  assert.equal(warnings(script(0,60,0,5))[0].message,'“B” overlaps “A” by 5s.');
  assert.equal(warnings(script(0,20,15,5))[0].message,'“B” overlaps “A” by 5s.');
});
test('touching and disjoint cues do not overlap', () => {
  assert.equal(warnings(script(0,20,20,5)).length,0); assert.equal(warnings(script(0,20,21,5)).length,0);
});
test('timing and syntax errors remain errors', () => {
  assert.ok(parse(script(0,20,89,5)).issues.some(x=>x.type==='error' && x.message.includes('ends after')));
  assert.ok(parse(script(0,20,30,0)).issues.some(x=>x.type==='error' && x.message.includes('greater than zero')));
  assert.ok(parse(script(0,20,30,5)+'\nunknown').issues.some(x=>x.type==='error' && x.message.includes('Unknown command')));
});
