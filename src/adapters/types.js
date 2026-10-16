// The contract an agent adapter fulfils. The wrapper, queue, log and
// interceptor are agent-neutral; an adapter only knows how to start its agent
// and how to plug a hook into it.
//
// A hook process connects to $INJECT_DIR/sock and sends
//   {op:'claim', boundary:'before-tool'|'after-tool', agent, event, doing,
//    projectDir, sessionId}
// then turns the returned messages into the agent's hook output:
//   before-tool + messages -> block the tool call with formatUrgent(messages)
//   after-tool  + messages -> add formatNotes(messages) as context
//
// To add an agent (e.g. Codex), create src/adapters/<id>/ exporting an
// Adapter and a hook entry point, and register it in src/adapters/index.js.

/**
 * @typedef {object} Adapter
 * @property {string} id            stable id, recorded in fixes.jsonl
 * @property {string} name          human-readable name
 * @property {string} command       executable the wrapper starts
 * @property {() => {path:string, changed:boolean}} install    register hooks
 * @property {() => {path:string, changed:boolean}} uninstall  remove hooks
 * @property {() => boolean} isInstalled
 */

export {};
