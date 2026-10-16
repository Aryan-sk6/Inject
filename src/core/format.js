// Wording the agent sees. Agent-neutral: adapters wrap these strings in
// whatever output shape their hook system expects.

function bullets(msgs) {
  if (msgs.length === 1) return msgs[0].text;
  return msgs.map((m) => `- ${m.text}`).join('\n');
}

/** Context for normal notes delivered after a tool call. */
export function formatNotes(msgs) {
  return [
    `[inject] The user sent ${msgs.length === 1 ? 'a message' : 'messages'} while you were working. You were not interrupted:`,
    '',
    bullets(msgs),
    '',
    'Take this into account from your next step on.',
  ].join('\n');
}

/** Reason shown to the agent when an urgent message blocks a tool call. */
export function formatUrgent(msgs) {
  const urgent = msgs.filter((m) => m.urgency === 'urgent');
  const notes = msgs.filter((m) => m.urgency !== 'urgent');
  const lines = [
    '[inject] This tool call was blocked and did not run, because the user sent an urgent message while you were working:',
    '',
    bullets(urgent),
  ];
  if (notes.length) lines.push('', 'Also from the user:', '', bullets(notes));
  lines.push('', 'Re-plan with this in mind before you continue. If the blocked call is still right, you may retry it.');
  return lines.join('\n');
}
