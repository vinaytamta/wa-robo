const fs = require('fs');
const path = require('path');

// Patch the bundle that gets served (public/assets/)
const bundlePath = path.join(__dirname, '../../../public/assets/index-CPfyPHiu.js');
let s = fs.readFileSync(bundlePath, 'utf8');

// 1. Add Type column header (after Group, before Status)
const oldHeader = 'p.jsx("th",{className:"px-6 py-4",children:"Group"}),p.jsx("th",{className:"px-6 py-4",children:"Status"})';
const newHeader = 'p.jsx("th",{className:"px-6 py-4",children:"Group"}),p.jsx("th",{className:"px-6 py-4",children:"Type"}),p.jsx("th",{className:"px-6 py-4",children:"Status"})';
if (s.indexOf(oldHeader) < 0) {
  console.error('Send Messages table header not found (may already be patched)');
  process.exit(1);
}
s = s.split(oldHeader).join(newHeader);

// 2. Add Type cell in each row (after Group td, before Status td)
// Match: Group td closing })}), then Status td with h(m.status)
const oldRow = 'children:m.resolvedGroup?.name||m.groupName||"-"})}),p.jsx("td",{className:"px-6 py-4",children:p.jsx("span",{className:`inline-flex items-center px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wide ${h(m.status)}`,children:m.status})})';
const newRow = 'children:m.resolvedGroup?.name||m.groupName||"-"})}),p.jsx("td",{className:"px-6 py-4",children:p.jsx("span",{className:`inline-flex items-center px-2.5 py-1 rounded text-xs font-bold ${m.deliveryType==="compose"?"bg-cyan-50 text-cyan-700":"bg-slate-100 text-slate-700"}`,children:m.deliveryType==="compose"?"Compose":"Scheduled"})}),p.jsx("td",{className:"px-6 py-4",children:p.jsx("span",{className:`inline-flex items-center px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wide ${h(m.status)}`,children:m.status})})';
if (s.indexOf(oldRow) < 0) {
  console.error('Send Messages table row pattern not found');
  process.exit(1);
}
s = s.split(oldRow).join(newRow);

// 3. Update empty state colSpan from 5 to 6
const oldColSpan = 'colSpan:5,className:"px-6 py-12 text-center text-slate-400",children:"No jobs found. Upload messages to get started."';
const newColSpan = 'colSpan:6,className:"px-6 py-12 text-center text-slate-400",children:"No jobs found. Upload messages to get started."';
if (s.indexOf(oldColSpan) < 0) {
  console.error('Send Messages empty state colSpan not found');
  process.exit(1);
}
s = s.split(oldColSpan).join(newColSpan);

fs.writeFileSync(bundlePath, s);
console.log('Send Messages table (Type column) patched successfully.');
