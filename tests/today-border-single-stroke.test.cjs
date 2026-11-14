const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const css=fs.readFileSync(path.join(root,'assets/calendar.css'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const sw=fs.readFileSync(path.join(root,'service-worker.js'),'utf8');

test('today draws one solid red edge and glow has no duplicate border',()=>{
 assert.match(css,/\.day-cell\.is-today\{position:relative;box-shadow:inset 0 0 0 3px #ad0a20;/);
 assert.match(css,/\.day-cell\.is-today::after\{content:"";position:absolute;inset:0;border:0;/);
 assert.doesNotMatch(css,/\.day-cell\.is-today::after\{border-width:3px;/);
 assert.doesNotMatch(css,/\.day-cell\.is-today::after\{content:"";position:absolute;inset:0;border:3px/);
 const pulse=css.slice(css.indexOf('@keyframes todayRedBorderPulse'),css.indexOf('.registration-dialog'));
 assert.ok(pulse.includes('inset 0 0 17px 3px rgba(255,36,62,.58)'));
 assert.ok(pulse.includes('animation:todayRedBorderPulse 1.65s'));
 assert.ok(!pulse.includes('inset 0 0 0 1px'),'no second crisp inner stroke');
});

test('reduced-motion path retains a constant visible red stroke',()=>{
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)\s*\{\s*\.day-cell\.is-today::after/);
 assert.match(css,/\.day-cell\.is-today::after\{\s*animation:none;\s*opacity:1;\s*box-shadow:none;/);
});

test('existing team card accent and off-day color remain unchanged',()=>{
 assert.match(css,/border-left:4px solid var\(--accent\)/);
 assert.match(css,/\.cell-shift \.shift-off-letter\{color:#d22337!important/);
});

test('the PWA loads the new CSS and invalidates the former cache',()=>{
 assert.match(html,/assets\/calendar\.css\?v=20261114\.4/);
 assert.match(sw,/assets\/calendar\.css\?v=20261114\.4/);
 assert.match(sw,/snnc-pwa-v58/);
});
