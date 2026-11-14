import { startShell, toast as gmToast } from './gm/shell.js';

// GraphMind Circuit dashboard. Dependency-free; talks only to its own
// server's /v1 and /auth, by URLs relative to the page, so the same files
// work at the origin root (`circuit dev`) and under a prefix (the platform's
// /circuit/). All run data is rendered with textContent (never innerHTML):
// step inputs/outputs are customer data and must never be interpreted.

const POLL_MS = 1500;
// The shared GraphMind shell: top bar, sign-in, and the one account page (on the hub inside the platform).
const shell = await startShell({ product: 'circuit' });
const state = {
  apiKey: sessionStorage.getItem('circuit.apiKey') ?? '',
  workflows: [],
  dev: false,
  templates: [],
  runs: [],
  filter: '',
  runId: null,
  seq: null,
  detail: null,
  detailSig: '',
  dirty: false, // a fix form has unsaved edits: don't clobber it on poll
};

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
const pretty = (v) => (v === undefined ? '—' : JSON.stringify(v, null, 2));
const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleString();
};
const until = (ts) => {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `on ${new Date(ts).toLocaleString()}`;
};
const badge = (status) => h('span', { class: `badge s-${status}` }, status.replace('_', ' '));

const toast = gmToast;

// ---------- API ----------
async function api(method, path, body, retried = false) {
  const headers = { 'x-circuit-actor': actor() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.apiKey) headers.authorization = `Bearer ${state.apiKey}`;
  const res = await fetch(`v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401) {
    if (shell.server.accounts && !retried) {
      shell.user = null; // the session ended: sign in (on the hub inside the platform), then try again
      await shell.requireSession();
      shell.renderBar();
      return api(method, path, body, true);
    }
    askForKey();
    throw new Error('API key required');
  }
  if (!res.ok && !(path === '/deploy-check' && res.status === 409)) {
    throw new Error(data?.detail ?? data?.title ?? `HTTP ${res.status}`);
  }
  return { status: res.status, data };
}

function actor() {
  return shell.user?.email || localStorage.getItem('circuit.actor') || 'dashboard';
}

// ---------- routing: #/runs/<id>[/<seq>] ----------
function readRoute() {
  const m = location.hash.match(/^#\/runs\/([\w-]+)(?:\/(\d+))?/);
  state.runId = m ? m[1] : null;
  state.seq = m && m[2] !== undefined ? Number(m[2]) : null;
}
function go(runId, seq) {
  location.hash = runId ? `#/runs/${runId}${seq !== null && seq !== undefined ? `/${seq}` : ''}` : '#/';
}
window.addEventListener('hashchange', () => {
  readRoute();
  state.dirty = false;
  state.detailSig = '';
  refresh();
});

// ---------- runs list ----------
function renderRuns() {
  const list = $('run-list');
  list.replaceChildren();
  if (state.runs.length === 0) {
    list.append(h('li', { class: 'none' }, state.filter ? `No ${state.filter} runs.` : 'No runs yet.'));
    return;
  }
  for (const run of state.runs) {
    list.append(
      h('li', {
        class: [run.id === state.runId && 'selected', run.status === 'paused' && 'needs-human'].filter(Boolean).join(' '),
        onclick: () => go(run.id, run.pausedSeq ?? null),
        title: run.id,
      },
        h('div', { class: 'row1' }, h('span', { class: 'wf' }, run.workflow), badge(run.status)),
        h('div', { class: 'row2' }, h('code', {}, run.id.slice(0, 16)), h('span', {}, ago(run.createdAt))),
      ),
    );
  }
}

/** After acting on a held step: drop focus and follow the run onward. */
function afterAction(runId) {
  document.activeElement?.blur?.();
  state.dirty = false;
  state.fixAction = null;
  state.seq = null;
  state.detailSig = '';
  history.replaceState(null, '', `#/runs/${runId}`);
}

// ---------- run detail ----------
function entrySubline(e) {
  if (e.status === 'paused') {
    if (e.kind === 'approval') return 'waiting for approval';
    return `held ${e.pausePoint ?? 'before'} — needs a human`;
  }
  if (e.status === 'suspended') {
    if (e.kind === 'sleep' && e.wakeAt) return `sleeping, wakes ${until(e.wakeAt)}`;
    if (e.kind === 'wait') return `waiting for "${e.waitEvent}"${e.expiresAt ? `, times out ${until(e.expiresAt)}` : ''}`;
    if (e.kind === 'child') return `waiting for child run ${e.childRunId ?? ''}`;
  }
  if (e.status === 'running' && e.wakeAt && e.wakeAt > Date.now()) return `retrying ${until(e.wakeAt)} (attempt ${e.attempts.length + 1})`;
  const n = e.attempts.length;
  const dur = e.finishedAt && e.startedAt ? `${e.finishedAt - e.startedAt}ms` : '';
  return [n > 1 ? `${n} attempts` : '', dur].filter(Boolean).join(' · ');
}

function renderTimeline(run, journal) {
  const ul = h('ul', { class: 'timeline' });
  for (const e of journal) {
    const fixes = e.kind === 'approval' && e.output && typeof e.output === 'object'
      ? (e.output.timedOut ? 'denied: nobody decided in time' : `${e.output.approved ? 'approved' : 'denied'} by ${e.output.by}`)
      : e.interventions.map((i) => `${i.action} by ${i.actor}`).join(', ');
    ul.append(
      h('li', {
        class: `node st-${e.status} s-${e.status}${e.seq === state.seq ? ' selected' : ''}`,
        onclick: () => go(run.id, e.seq),
      },
        h('span', { class: 'dot' }),
        h('div', {}, h('span', { class: 'nm' }, e.name), h('span', { class: 'kd' }, `#${e.seq} ${e.kind}`), ' ', badge(e.status)),
        h('div', { class: 'sub' }, entrySubline(e)),
        fixes && h('div', { class: 'fix' }, `✎ ${fixes}`),
      ),
    );
  }
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'aborted' || run.status === 'timed_out') {
    ul.append(
      h('li', { class: `node output-node st-${run.status === 'completed' ? 'completed' : 'failed'} s-${run.status}` },
        h('span', { class: 'dot' }),
        h('div', {}, h('span', { class: 'nm' }, run.status === 'completed' ? 'result' : run.status.replace('_', ' '))),
        h('div', { class: 'sub' }, run.status === 'completed' ? JSON.stringify(run.output ?? null).slice(0, 80) : (run.error?.message ?? '').slice(0, 120)),
      ),
    );
  }
  if (journal.length === 0 && run.status === 'queued') ul.append(h('li', { class: 'node' }, h('div', { class: 'sub' }, 'Queued — the engine will pick it up in a moment.')));
  return ul;
}

function jsonField(label, initial, id) {
  const ta = h('textarea', { id, spellcheck: 'false', oninput: () => { state.dirty = true; err.textContent = ''; } });
  ta.value = initial === undefined ? '' : JSON.stringify(initial, null, 2);
  const err = h('div', { class: 'err' });
  return { el: h('div', { class: 'field' }, h('label', { for: id }, label), ta, err), ta, err };
}
function parseJson(field, allowEmpty = false) {
  const text = field.ta.value.trim();
  if (text === '' && allowEmpty) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) { field.err.textContent = `Not valid JSON: ${e.message}`; return { ok: false }; }
}

const ACTIONS = {
  error: [
    ['retry', 'Retry', 'Run the step again for real. Optionally change its input first.'],
    ['inject', 'Inject result', "Don't run it. Use the result you type below, and continue the workflow."],
    ['skip', 'Skip', 'Continue as if the step returned nothing (undefined).'],
    ['continue', 'Let it fail', 'Release the original error into the workflow code (it may catch it, or the run fails).'],
    ['abort', 'Abort run', 'Stop the whole run as aborted.'],
  ],
  before: [
    ['continue', 'Run it', 'Run the step now with its input.'],
    ['edit', 'Edit & run', 'Change the input, then run the step.'],
    ['inject', 'Inject result', "Don't run it; use this result."],
    ['skip', 'Skip', 'Continue as if the step returned nothing.'],
    ['abort', 'Abort run', 'Stop the whole run as aborted.'],
  ],
  after: [
    ['continue', 'Keep result', 'Accept the result the step produced.'],
    ['inject', 'Replace result', 'Continue with a different result.'],
    ['retry', 'Retry', 'Run the step again for real.'],
    ['abort', 'Abort run', 'Stop the whole run as aborted.'],
  ],
};

function renderFixPanel(run, e) {
  const point = e.pausePoint ?? 'before';
  const choices = ACTIONS[point] ?? ACTIONS.before;
  let chosen = state.fixAction && choices.some((c) => c[0] === state.fixAction) ? state.fixAction : choices[0][0];
  const panel = h('div', { class: 'fix-panel' });
  const body = h('div');
  const reason = h('input', { id: 'fix-reason', placeholder: 'why (recorded on the run)', oninput: () => (state.dirty = true) });
  const draw = () => {
    body.replaceChildren();
    const meta = choices.find((c) => c[0] === chosen);
    body.append(h('p', { class: 'explain' }, meta[2]));
    let field = null;
    if (chosen === 'inject') field = jsonField('Result (JSON)', e.output ?? suggestOutput(e), 'fix-json');
    if (chosen === 'edit' || chosen === 'retry') field = jsonField(chosen === 'edit' ? 'Input (JSON)' : 'New input (JSON, optional — leave empty to keep it)', chosen === 'edit' ? e.input ?? null : undefined, 'fix-json');
    if (field) body.append(field.el);
    body.append(
      h('div', { class: 'field' }, h('label', { for: 'fix-reason' }, 'Reason'), reason),
      h('div', { class: 'row' },
        h('button', {
          class: chosen === 'abort' ? 'danger' : 'primary',
          type: 'button',
          onclick: async (ev) => {
            const payload = { action: chosen };
            if (field) {
              const parsed = parseJson(field, chosen === 'retry');
              if (!parsed.ok) return;
              if (parsed.value !== undefined) payload[chosen === 'inject' ? 'output' : 'input'] = parsed.value;
            }
            if (reason.value.trim()) payload.reason = reason.value.trim();
            ev.target.disabled = true;
            try {
              await api('POST', `/runs/${run.id}/entries/${e.seq}/resume`, payload);
              toast(`${meta[1]} applied to "${e.name}" — the run continues.`);
              afterAction(run.id);
              await settleThenRefresh();
            } catch (err) { toast(err.message, true); ev.target.disabled = false; }
          },
        }, `${meta[1]}`),
        h('span', { class: 'hint' }, `as ${actor()}`),
      ),
    );
  };
  const tabs = h('div', { class: 'tabs' }, choices.map(([key, label]) =>
    h('button', { type: 'button', class: key === chosen ? 'on' : '', onclick: (ev) => {
      chosen = key; state.fixAction = key;
      for (const b of tabs.children) b.classList.toggle('on', b === ev.target);
      draw();
    } }, label)));
  const heading = point === 'error' ? 'This step failed — fix it and resume'
    : e.error?.name === 'ApprovalRequired' ? 'Policy: a human must approve this MCP call — check the arguments'
    : e.error?.name === 'ToolDefinitionChanged' ? 'This MCP tool changed since it was trusted — review before running'
    : `Held ${point} this step — decide how to continue`;
  panel.append(h('h4', {}, heading), tabs, body);
  draw();
  return panel;
}

function suggestOutput(e) {
  // A sensible starting point for "inject": the previous successful output
  // isn't known, so offer an empty object the user edits.
  return e.kind === 'step' ? {} : null;
}

function renderApprovalPanel(run, e) {
  const comment = h('input', { id: 'appr-comment', placeholder: 'comment (optional)', oninput: () => (state.dirty = true) });
  const decide = async (approved, btn) => {
    btn.disabled = true;
    try {
      await api('POST', `/runs/${run.id}/approvals/${e.seq}`, { approved, by: actor(), ...(comment.value.trim() ? { comment: comment.value.trim() } : {}) });
      toast(approved ? 'Approved — the run continues.' : 'Denied — the run continues down the denied path.');
      afterAction(run.id);
      await settleThenRefresh();
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  };
  const ctx = e.input?.context;
  return h('div', { class: 'fix-panel' },
    h('h4', {}, 'Approval requested'),
    e.input?.approvers ? h('p', { class: 'explain' }, `Approvers: ${e.input.approvers.join(', ')}`) : null,
    e.expiresAt ? h('p', { class: 'explain' }, `Auto-denies ${until(e.expiresAt)} if nobody decides.`) : null,
    ctx !== undefined && ctx !== null ? h('div', { class: 'field' }, h('label', {}, 'Context'), h('pre', { class: 'json' }, pretty(ctx))) : null,
    h('div', { class: 'field' }, h('label', { for: 'appr-comment' }, 'Comment'), comment),
    h('div', { class: 'row' },
      h('button', { class: 'primary', type: 'button', onclick: (ev) => decide(true, ev.target) }, 'Approve'),
      h('button', { class: 'danger', type: 'button', onclick: (ev) => decide(false, ev.target) }, 'Deny'),
      h('span', { class: 'hint' }, `as ${actor()}`),
    ),
  );
}

function renderInspector(run, e) {
  if (!e) {
    return h('div', { class: 'panel' },
      h('h3', {}, 'Run'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'input'), h('dd', {}, h('pre', { class: 'json' }, pretty(run.input))),
        run.output !== undefined && h('dt', {}, 'output'), run.output !== undefined && h('dd', {}, h('pre', { class: 'json' }, pretty(run.output))),
        run.error && h('dt', {}, 'error'), run.error && h('dd', {}, `${run.error.name}: ${run.error.message}`),
      ),
      h('p', { class: 'hint' }, 'Select a step on the left to inspect it.'),
    );
  }
  const panel = h('div', { class: 'panel' });
  panel.append(
    h('div', { class: 'row' }, h('h3', {}, e.name), badge(e.status), h('span', { class: 'hint' }, `#${e.seq} · ${e.kind} · call ${e.ordinal + 1}`)),
  );
  if (e.status === 'paused' && e.kind === 'approval') panel.append(renderApprovalPanel(run, e));
  else if (e.status === 'paused') panel.append(renderFixPanel(run, e));

  if (e.error) panel.append(h('h4', {}, 'Error'), h('pre', { class: 'json' }, `${e.error.name}: ${e.error.message}`));
  if (e.input !== undefined) panel.append(h('h4', {}, 'Input'), h('pre', { class: 'json' }, pretty(e.input)));
  if (e.output !== undefined) panel.append(h('h4', {}, 'Output'), h('pre', { class: 'json' }, pretty(e.output)));
  if (e.attempts.length > 0) {
    panel.append(h('h4', {}, `Attempts (${e.attempts.length})`), h('ol', { class: 'list' }, e.attempts.map((a) =>
      h('li', {}, `${new Date(a.startedAt).toLocaleTimeString()}${a.finishedAt ? ` · ${a.finishedAt - a.startedAt}ms` : ''} — `,
        a.error ? h('span', { class: 's-failed' }, a.error.message) : h('span', { class: 's-completed' }, 'ok')))));
  }
  if (e.interventions.length > 0) {
    panel.append(h('h4', {}, 'Human interventions'), h('ol', { class: 'list' }, e.interventions.map((i) =>
      h('li', {}, `${i.action} by ${i.actor}, ${new Date(i.at).toLocaleString()}${i.reason ? ` — "${i.reason}"` : ''}${i.injectedOutput ? ' (supplied result)' : ''}${i.editedInput ? ' (changed input)' : ''}`))));
  }
  if (e.status === 'completed' && (e.kind === 'step' || e.kind === 'child')) {
    panel.append(h('h4', {}, 'What if?'), h('p', { class: 'explain' }, 'Fork this run with a different result here; everything after it runs again for real. The original run is not touched.'),
      h('button', { type: 'button', onclick: () => openForkDialog(run, e) }, 'Fork from here…'));
  }
  return panel;
}

function renderDetail() {
  const root = $('detail');
  const d = state.detail;
  if (!state.runId) {
    root.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'No run selected'),
      h('p', {}, 'Start one with ', h('b', {}, 'New run'), ', or select a run on the left.'),
      h('p', { class: 'hint' }, 'Paused runs (waiting on a human) are highlighted. Open one to fix it and resume.')));
    return;
  }
  if (!d) { root.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Loading…'))); return; }
  const { run, journal } = d;
  const entry = state.seq !== null ? journal.find((x) => x.seq === state.seq) : undefined;

  let banner = null;
  if (run.status === 'paused') {
    const held = journal.find((x) => x.seq === run.pausedSeq);
    banner = h('div', { class: 'banner' }, `Paused at "${held?.name ?? '?'}" — waiting for a human. `,
      state.seq !== run.pausedSeq ? h('a', { href: `#/runs/${run.id}/${run.pausedSeq}` }, 'Open it') : 'Choose below.');
  } else if (run.status === 'failed' || run.status === 'timed_out' || run.status === 'aborted') {
    banner = h('div', { class: 'banner err' }, `${run.error?.name ?? run.status}: ${run.error?.message ?? ''}`);
  } else if (run.status === 'completed') {
    banner = h('div', { class: 'banner ok' }, 'Completed.');
  }

  root.replaceChildren(
    h('div', { class: 'run-head' }, h('h2', {}, run.workflow), badge(run.status)),
    h('div', { class: 'run-meta' },
      h('code', {}, run.id),
      h('span', {}, `started ${ago(run.createdAt)}`),
      run.finishedAt && h('span', {}, `took ${Math.round((run.finishedAt - run.createdAt) / 100) / 10}s`),
      run.forkedFrom && h('a', { href: `#/runs/${run.forkedFrom.runId}` }, `forked from ${run.forkedFrom.runId.slice(0, 16)}`),
      run.parentRunId && h('a', { href: `#/runs/${run.parentRunId}` }, `child of ${run.parentRunId.slice(0, 16)}`),
      h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); downloadFixture(run); } }, 'download fixture'),
      ['queued', 'running', 'suspended'].includes(run.status) &&
        h('a', { href: '#', class: 's-failed', onclick: async (ev) => {
          ev.preventDefault();
          try { await api('POST', `/runs/${run.id}/cancel`); toast('Run aborted.'); state.detailSig = ''; await refresh(); }
          catch (err) { toast(err.message, true); }
        } }, 'abort run'),
    ),
    banner,
    h('div', { class: 'cols' }, renderTimeline(run, journal), renderInspector(run, entry)),
  );
}

// ---------- dialogs ----------
function openDialog(title, content, onSubmit, submitLabel = 'Submit') {
  const dlg = $('dialog');
  const err = h('div', { class: 'field' }, h('div', { class: 'err' }));
  const submit = h('button', { class: 'primary', type: 'submit' }, submitLabel);
  const form = h('form', { method: 'dialog', onsubmit: async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    err.firstChild.textContent = '';
    try { await onSubmit(); dlg.close(); }
    catch (e) { err.firstChild.textContent = e.message; }
    finally { submit.disabled = false; }
  } },
    h('h3', {}, title), content, err,
    h('div', { class: 'row' }, submit, h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel')));
  dlg.replaceChildren(form);
  dlg.showModal();
}

function exampleFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return {};
  if (schema.type === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = exampleFromSchema(v);
    return out;
  }
  if (schema.type === 'string') return schema.enum?.[0] ?? '';
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return [];
  return null;
}

function openNewRunDialog() {
  if (state.workflows.length === 0) { toast('No workflows are registered with this server.', true); return; }
  const select = h('select', { id: 'nr-wf' }, state.workflows.map((w) => h('option', { value: w.name }, w.name)));
  const input = jsonField('Input (JSON)', undefined, 'nr-input');
  const idem = h('input', { id: 'nr-idem', placeholder: 'optional — same key returns the same run' });
  const schemaNote = h('p', { class: 'explain' });
  const sync = () => {
    const wf = state.workflows.find((w) => w.name === select.value);
    input.ta.value = JSON.stringify(wf?.inputSchema ? exampleFromSchema(wf.inputSchema) : {}, null, 2);
    schemaNote.textContent = wf?.inputSchema ? `Expected input: ${JSON.stringify(wf.inputSchema.properties ?? wf.inputSchema)}` : 'This workflow accepts any JSON input.';
    if (wf?.name === 'triage-invoice') input.ta.value = JSON.stringify({ invoiceId: 'flaky-big-001' }, null, 2);
  };
  select.addEventListener('change', sync);
  sync();
  openDialog('Start a run', h('div', {},
    h('div', { class: 'field' }, h('label', { for: 'nr-wf' }, 'Workflow'), select),
    schemaNote, input.el,
    h('div', { class: 'field' }, h('label', { for: 'nr-idem' }, 'Idempotency key'), idem),
    h('p', { class: 'hint' }, 'Equivalent to: POST /v1/workflows/<name>/runs — this is how your app starts runs.'),
  ), async () => {
    const parsed = parseJson(input, true);
    if (!parsed.ok) throw new Error('Fix the JSON input first.');
    const { data } = await api('POST', `/workflows/${select.value}/runs`, { input: parsed.value ?? null, ...(idem.value.trim() ? { idempotencyKey: idem.value.trim() } : {}) });
    toast(`Run ${data.runId} started.`);
    go(data.runId);
  }, 'Start run');
}

function openEventDialog() {
  const name = h('input', { id: 'ev-name', value: 'payment.settled', required: true });
  const data = jsonField('Data (JSON)', { invoiceId: 'flaky-big-001' }, 'ev-data');
  openDialog('Send an event', h('div', {},
    h('div', { class: 'field' }, h('label', { for: 'ev-name' }, 'Event name'), name), data.el,
    h('p', { class: 'hint' }, 'Runs waiting for this event whose match fields equal these values continue. Equivalent to: POST /v1/events.'),
  ), async () => {
    const parsed = parseJson(data, true);
    if (!parsed.ok) throw new Error('Fix the JSON data first.');
    const { data: res } = await api('POST', '/events', { name: name.value.trim(), data: parsed.value ?? null });
    toast(res.matchedRuns.length ? `Delivered to ${res.matchedRuns.length} waiting run(s).` : 'Event recorded — no run was waiting for it.');
    state.detailSig = '';
    await refresh();
  }, 'Send');
}

function openForkDialog(run, e) {
  const out = jsonField(`Result of "${e.name}" in the fork (JSON)`, e.output ?? null, 'fork-out');
  openDialog('Fork: what if this step had returned something else?', h('div', {},
    h('p', { class: 'explain' }, `Steps before #${e.seq} are reused from this run. "${e.name}" returns the value below. Everything after runs for real in a new run.`),
    out.el,
  ), async () => {
    const parsed = parseJson(out);
    if (!parsed.ok) throw new Error('Fix the JSON first.');
    const { data } = await api('POST', `/runs/${run.id}/fork`, { substitute: { seq: e.seq, output: parsed.value } });
    toast(`Fork ${data.runId} started.`);
    go(data.runId);
  }, 'Fork');
}

async function runDeployCheck() {
  try {
    const { status, data } = await api('POST', '/deploy-check');
    if (status === 200) {
      toast(`Deploy check passed: ${data.checked} in-flight run(s) are compatible with the loaded code.`);
    } else {
      const lines = data.broken.map((b) => `${b.runId.slice(0, 16)} (${b.workflow}): ${b.outcome.kind === 'diverged' ? b.outcome.divergence.type : b.outcome.kind}`);
      toast(`Deploy check: ${data.broken.length} of ${data.checked} in-flight run(s) would break — ${lines.join('; ')}`, true);
    }
  } catch (err) { toast(err.message, true); }
}

function askForKey() {
  if ($('dialog').open) return;
  const key = h('input', { id: 'key', type: 'password', placeholder: 'ck_…', required: true });
  const who = h('input', { id: 'who', value: localStorage.getItem('circuit.actor') ?? '', placeholder: 'you@team' });
  openDialog('This server requires an API key', h('div', {},
    h('div', { class: 'field' }, h('label', { for: 'key' }, 'API key (kept for this browser tab only)'), key),
    h('div', { class: 'field' }, h('label', { for: 'who' }, 'Your name (recorded on fixes and approvals)'), who),
  ), async () => {
    state.apiKey = key.value.trim();
    sessionStorage.setItem('circuit.apiKey', state.apiKey);
    if (who.value.trim()) localStorage.setItem('circuit.actor', who.value.trim());
    await boot();
  }, 'Connect');
}

// ---------- refresh loop ----------
async function refresh() {
  const conn = $('conn');
  try {
    const q = new URLSearchParams({ limit: '100', ...(state.filter ? { status: state.filter } : {}) });
    const { data } = await api('GET', `/runs?${q}`);
    state.runs = data.runs;
    renderRuns();
    if (state.runId) {
      const { data: detail } = await api('GET', `/runs/${state.runId}`).catch((e) => {
        if (String(e.message).includes('not found')) { toast('That run does not exist on this server.', true); go(null); }
        throw e;
      });
      // A run opened without a step selected, and waiting on a human, opens
      // straight on the held step: that is the thing to act on.
      if (state.seq === null && detail.run.status === 'paused' && detail.run.pausedSeq !== undefined) {
        state.seq = detail.run.pausedSeq;
        history.replaceState(null, '', `#/runs/${detail.run.id}/${state.seq}`);
        state.detailSig = '';
      }
      const sig = JSON.stringify(detail);
      const editing = state.dirty || document.activeElement?.closest?.('.fix-panel, dialog');
      if (sig !== state.detailSig && !editing) {
        state.detail = detail;
        state.detailSig = sig;
        renderDetail();
      }
    } else if (state.detail !== null || state.detailSig !== 'none') {
      state.detail = null;
      state.detailSig = 'none';
      renderDetail();
    }
    conn.textContent = `connected · ${state.workflows.length} workflow(s) · you are ${actor()}`;
    conn.className = 'conn ok';
  } catch (err) {
    conn.textContent = `disconnected — ${err.message}`;
    conn.className = 'conn bad';
  }
}

/** Give the engine a beat to move the run, so the view lands on its next state. */
async function settleThenRefresh() {
  await new Promise((r) => setTimeout(r, 250));
  await refresh();
}

async function boot() {
  await shell.requireSession(); // no-op without accounts; inside the platform, the hub's sign-in
  const { data: health } = await api('GET', '/health');
  state.dev = health.dev === true;
  state.templates = health.templates ?? [];
  $('btn-new-wf').hidden = !state.dev;
  const { data } = await api('GET', '/workflows');
  state.workflows = data.workflows;
  await refresh();
  state.booted = true;
}

function openNewWorkflowDialog() {
  const name = h('input', { id: 'nwf-name', placeholder: 'my-workflow (kebab-case)', required: true, pattern: '[a-z0-9][a-z0-9-]*' });
  const tpl = h('select', { id: 'nwf-tpl' }, state.templates.map((t) => h('option', { value: t }, t)));
  openDialog('New workflow', h('div', {},
    h('p', { class: 'explain' }, 'Writes a starter workflow into the loaded workflows file; the dev server reloads it automatically. Workflows are code — open the file to build from there.'),
    h('div', { class: 'field' }, h('label', { for: 'nwf-name' }, 'Name'), name),
    h('div', { class: 'field' }, h('label', { for: 'nwf-tpl' }, 'Template'), tpl),
  ), async () => {
    const { data } = await api('POST', '/dev/scaffold', { name: name.value.trim(), template: tpl.value });
    toast(`'${data.workflow}' added to ${data.file.split('/').pop()} — reloading; it will appear under New run in a moment.`);
    setTimeout(async () => { const { data: d } = await api('GET', '/workflows'); state.workflows = d.workflows; }, 800);
  }, 'Create');
}

async function downloadFixture(run) {
  try {
    const headers = state.apiKey ? { authorization: `Bearer ${state.apiKey}` } : {};
    const res = await fetch(`v1/runs/${run.id}/fixture`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `${run.workflow}-${run.id}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) { toast(`fixture download failed: ${err.message}`, true); }
}

$('btn-new-run').addEventListener('click', openNewRunDialog);
$('btn-new-wf').addEventListener('click', openNewWorkflowDialog);
$('btn-event').addEventListener('click', openEventDialog);
$('btn-deploy-check').addEventListener('click', runDeployCheck);
$('status-filter').addEventListener('change', (ev) => { state.filter = ev.target.value; refresh(); });
$('conn').addEventListener('click', () => {
  if (shell.user) { location.href = shell.accountHref(); return; } // your name comes from your account
  const name = prompt('Your name, recorded on every fix and approval you make:', actor());
  if (name && name.trim()) { localStorage.setItem('circuit.actor', name.trim()); refresh(); }
});

readRoute();
boot().catch(() => {});
setInterval(() => { if (!document.hidden && state.booted) refresh(); }, POLL_MS);
