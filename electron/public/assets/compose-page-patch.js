/**
 * Compose (simple message sending) page - injected component.
 * This file documents the zW component added to the dashboard bundle.
 * The actual implementation is in index-CPfyPHiu.js: search for case"compose":return p.jsx(zW,{})
 * and ensure zW is defined. If Compose menu item shows but page is blank, zW was not inserted.
 *
 * zW (Compose page) behaviour:
 * - Fetches groups from GET /api/groups
 * - Form: message textarea, group select, Send button
 * - On submit: POST /api/posting/send-now { messageText, groupName }
 * - Inline error/success messages
 * - Design: text-3xl font-bold text-[#002060], bg-white rounded border border-slate-100, shadow, px-6 py-2.5, focus:ring-[#00a0e9]/20, btn bg-[#002060]
 */
