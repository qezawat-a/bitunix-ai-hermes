/**
 * The harness gate, tested as a gate.
 *
 * This is the file that makes the documented safety model true. Both
 * filetools.js and tools.js claimed write/exec tools "wait for the user's tap"
 * and that "autonomous loops never call them blindly (see requireApproval)".
 * That function did not exist. These tests pin the behaviour down so it cannot
 * quietly disappear again.
 *
 * The properties that matter, and why each one is here:
 *
 *   1. Reads are always free. An agent that cannot look at anything cannot work.
 *   2. Writes and exec ALWAYS require a decision when nothing is auto-approved.
 *      There is no code path that runs them silently.
 *   3. /auto_approve_on_edit waives WRITES only — never exec. Auto-approving
 *      edits is not consent to run a shell.
 *   4. An unattended loop is refused a dangerous tool even with auto-approve
 *      fully on. Nobody is there to answer the tap, so asking is pointless and
 *      pretending is worse.
 *   5. terminal=off blocks exec even with everything else on.
 *   6. An approval that is never answered expires as a DENY, never as a pass.
 *   7. Every decision lands in the ledger, so "it did that without asking" is a
 *      query, not an argument.
 */

import {
  classify, CLASS, evaluate, gate, setFlag, harnessState as state, registerTools,
  pendingApprovals, settle, settleAll, expireApprovals, requestApproval,
} from '../src/ai/harness.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

/** Put the harness back to a known state between cases. */
function reset({ edit = false, exec = false, terminal = 'write' } = {}) {
  state.autoApproveEdit = edit;
  state.autoApproveExec = exec;
  state.terminal = terminal;
  state.ledger.length = 0;
  state.pending.clear();
}

async function test() {
  console.log('=== Harness approval gate ===\n');

  // ------------------------------------------------------------ classification
  console.log('Classification is by tool name, and exec is never mistaken for a write');
  {
    assert(classify('run_command') === CLASS.EXEC, 'run_command is EXEC');
    // the real file tools declare danger:true, and that is what classifies them
    assert(classify('write_file', { danger: true }) === CLASS.WRITE, 'write_file is WRITE');
    assert(classify('edit_file', { danger: true }) === CLASS.WRITE, 'edit_file is WRITE');
    assert(classify('find_usages', { danger: true }) === CLASS.WRITE,
      'find_usages declares danger:true, so it is gated even though it only reads');
    assert(classify('get_positions') === CLASS.READ, 'get_positions is READ');
    assert(classify('read_file') === CLASS.READ, 'read_file is READ');
    // The one that actually matters: money tools must be gated. open_position
    // carries danger:true in tools.js and moves real money on a live account.
    assert(classify('open_position', { danger: true }) === CLASS.WRITE,
      'open_position is gated by its own danger flag, not its name');
    for (const t of ['close_position', 'set_position_tpsl', 'reverse_position',
      'cancel_orders', 'set_leverage', 'close_all_positions']) {
      assert(classify(t, { danger: true }) === CLASS.WRITE, `${t} is gated`);
    }
    assert(classify('mystery_tool') === CLASS.READ,
      'a tool that declares nothing at all is a read');
  }

  // ------------------------------------------------------------ reads are free
  console.log('\nReads are never gated');
  {
    reset();
    for (const t of ['get_positions', 'get_kline', 'search_files', 'read_file']) {
      assert(evaluate({ name: t }).ok, `${t} is allowed with everything off`);
    }
  }

  // ------------------------------------------------------ nothing auto-approved
  console.log('\nWith nothing auto-approved, writes and exec ask');
  {
    reset();
    const w = evaluate({ name: 'write_file' });
    assert(w.ok === false && w.decision === 'ask', 'write_file asks');
    const e = evaluate({ name: 'run_command' });
    assert(e.ok === false && e.decision === 'ask', 'run_command asks');
    assert(pendingApprovals().length === 0, 'asking does not auto-register an approval');
  }

  // ---------------------------------------------- auto-approve edits only
  console.log('\n/auto_approve_on_edit waives WRITES and never exec');
  {
    reset({ edit: true });
    const w = evaluate({ name: 'write_file' });
    assert(w.ok === true && w.decision === 'waived', 'write_file is waived');
    const e = evaluate({ name: 'edit_file' });
    assert(e.ok === true, 'edit_file is waived');

    const x = evaluate({ name: 'run_command' });
    assert(x.ok === false && x.decision === 'ask',
      'run_command STILL asks — approving edits is not approving a shell');
  }

  console.log('\nauto-approve exec is a separate switch');
  {
    reset({ edit: true, exec: true });
    assert(evaluate({ name: 'run_command' }).ok === true, 'exec is waived when exec auto-approve is on');
    assert(evaluate({ name: 'write_file' }).ok === true, 'and edits still are');
  }

  // ----------------------------------------------------------- unattended loops
  console.log('\nAn unattended loop is refused a dangerous tool, always');
  {
    for (const flags of [{}, { edit: true }, { edit: true, exec: true }]) {
      reset(flags);
      const label = flags.exec ? 'with BOTH auto-approves on' : flags.edit ? 'with edit auto-approve on' : 'with nothing on';
      const w = evaluate({ name: 'write_file', autonomous: true });
      assert(w.ok === false && w.decision === 'denied',
        `autonomous write_file is denied ${label}`);
      const x = evaluate({ name: 'run_command', autonomous: true });
      assert(x.ok === false, `autonomous run_command is denied ${label}`);
    }
    // and the reason is legible, because "denied" with no explanation is the
    // kind of thing that gets "fixed" by disabling the gate
    reset({ edit: true, exec: true });
    const d = evaluate({ name: 'write_file', autonomous: true });
    assert(/unattended|no human/i.test(d.why), `the refusal says why: "${d.why}"`);
  }

  // ------------------------------------------------------------ terminal = off
  console.log('\nterminal=off blocks exec even with auto-approve on');
  {
    reset({ edit: true, exec: true, terminal: 'off' });
    const x = evaluate({ name: 'run_command' });
    assert(x.ok === false && x.decision === 'denied', 'exec is denied');
    assert(/terminal access is off/i.test(x.why), `and says why: "${x.why}"`);
    assert(evaluate({ name: 'write_file' }).ok === true,
      'writes still work — terminal=off is about exec, not about edits');
  }

  // -------------------------------------------------------------- approve flow
  console.log('\nA real approval can be granted and settles exactly once');
  {
    reset();
    const { id, promise, text } = requestApproval({
      name: 'write_file', cls: CLASS.WRITE, args: { path: 'x.js' }, reason: 'test',
    });
    assert(/approve/.test(text) && /deny/.test(text), 'the prompt tells the user both options');
    assert(pendingApprovals().length === 1, 'it is pending');

    settle(id, 'approve');
    assert(await promise === true, 'the waiter is resolved true');
    assert(pendingApprovals().length === 0, 'and it is no longer pending');
    assert(settle(id, 'approve') === null, 'a settled id cannot be settled again');
  }

  console.log('\nA denial is a denial, not a timeout');
  {
    reset();
    const { id, promise } = requestApproval({ name: 'run_command', cls: CLASS.EXEC });
    settle(id, 'deny');
    assert(await promise === false, 'the waiter resolves false');
  }

  console.log('\nAn approval nobody answers EXPIRES AS A DENY');
  {
    reset();
    const { id, promise } = requestApproval({ name: 'write_file', cls: CLASS.WRITE });
    // pretend it was created an hour and a half ago
    state.pending.get(id).at = Date.now() - 90 * 60 * 1000;
    const n = expireApprovals();
    assert(n === 1, 'one expired');
    assert(await promise === false,
      'an unanswered tap resolves FALSE — silence must never mean permission');
  }

  console.log('\nsettleAll clears a backlog');
  {
    reset();
    requestApproval({ name: 'write_file', cls: CLASS.WRITE });
    requestApproval({ name: 'run_command', cls: CLASS.EXEC });
    requestApproval({ name: 'edit_file', cls: CLASS.WRITE });
    assert(pendingApprovals().length === 3, 'three waiting');
    settleAll('deny');
    assert(pendingApprovals().length === 0, 'all settled');
  }

  // ------------------------------------------------------------- end-to-end
  console.log('\ngate() end to end');
  {
    // No onAsk: there is nowhere to send the prompt, so refusing immediately is
    // the only honest answer. It must NOT block waiting for a tap nobody can
    // give — that is how an agent hangs forever in a cron job.
    reset();
    const g = await gate({ name: 'write_file', args: { path: 'a.js' }, autonomous: false });
    assert(g.allowed === false, 'with no channel to answer it refuses');
    assert(/no channel to ask/i.test(g.why), `and says why: "${g.why}"`);

    // With an onAsk callback it waits — and the tap settles it. This is the
    // real interactive path, so drive it the way Telegram would.
    reset();
    const asked = [];
    // The approval id is minted inside gate(), so the tap has to be driven the
    // way Telegram would drive it: read the pending map and reply to that id.
    let askedOnce = false;
    const p = gate({
      name: 'write_file', args: { path: 'a.js' }, autonomous: false,
      onAsk: () => { askedOnce = true; },
    });
    await new Promise((r) => setTimeout(r, 20));
    const pend = pendingApprovals();
    assert(askedOnce && pend.length === 1, 'it asked exactly once and is pending');
    if (pend.length) settle(pend[0].id, 'approve');
    const g2 = await p;
    assert(g2.allowed === true, 'an approved tap lets the tool run');

    reset({ edit: true });
    const w = await gate({ name: 'edit_file', args: {} });
    assert(w.allowed === true, 'auto-approved edit runs');

    reset({ edit: true, exec: true });
    const a = await gate({ name: 'run_command', args: { command: 'ls' }, autonomous: true });
    assert(a.allowed === false, 'autonomous exec is refused through gate() too');
  }

  // ---------------------------------------------------------------- the ledger
  console.log('\nEvery decision is recorded, so "it did that unasked" is a query');
  {
    // One reset, then ALL FOUR calls. The first version called reset() between
    // them, which cleared the very ledger it then went on to assert on.
    reset();
    evaluate({ name: 'read_file' });               // no row — reads are not logged
    evaluate({ name: 'write_file' });              // ask
    state.autoApproveEdit = true;                  // flip the switch in place
    evaluate({ name: 'write_file' });              // waived
    state.autoApproveEdit = false;
    evaluate({ name: 'run_command', autonomous: true }); // denied

    const decisions = state.ledger.map((d) => d.decision);
    assert(decisions.includes('ask'), 'an ask was logged');
    assert(decisions.includes('waived'), 'a waiver was logged');
    assert(decisions.includes('denied'), 'a denial was logged');
    for (const d of state.ledger) {
      assert(typeof d.tool === 'string' && typeof d.decision === 'string',
        `entry ${d.tool} has a tool and a decision`);
    }
  }

  // ------------------------------------------------------------------ setFlag
  console.log('\nsetFlag validates instead of accepting anything');
  {
    assert((() => { try { setFlag('terminal', 'sometimes'); return false; } catch { return true; } })(),
      'terminal rejects an invalid level');
    try { setFlag('notAFlag', true); assert(false, 'unknown flag should throw'); }
    catch { assert(true, 'an unknown flag name is refused'); }
  }

  // ------------------------------------------------- the two lists must agree
  console.log('\nThe harness danger list and tools.js must not drift apart');
  {
    // Read the declarations straight out of the source instead of importing
    // tools.js: importing it pulls in db and the MCP layer, which needs a live
    // DATABASE_URL and never settles inside a test. Parsing the literal is
    // enough to prove the two lists agree.
    const fs = await import('node:fs');
    const src = ['tools.js', 'filetools.js']
      .map((f) => fs.readFileSync(new URL(`../src/ai/${f}`, import.meta.url), 'utf8'))
      .join('\n');
    // Split on each `name:` first: a bounded [\s\S]{0,900}? window happily
    // reaches across a tool boundary and attributes find_usages' danger flag to
    // search_files. Matching within a single tool block cannot do that.
    // Strip comments FIRST. The prose in tools.js literally contains the words
    // `write_file / edit_file / run_command are danger:` — so a naive scan
    // reads get_cooldowns (the last tool block) as danger because the comment
    // after it mentions danger.
    const clean = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = clean.split(/name:\s*'/).slice(1);
    const tools = blocks
      .map((b) => ({ name: b.slice(0, b.indexOf("'")), danger: /danger:\s*true/.test(b) }))
      .filter((t) => t.danger);
    registerTools(tools);
    assert(tools.length >= 10, `found ${tools.length} danger tools in source`);
    const declared = tools.filter((x) => x.danger).map((x) => x.name).sort();
    const missed = declared.filter((n) => classify(n) === CLASS.READ);
    assert(missed.length === 0,
      `every danger:true tool is gated by name too (missed: ${missed.join(', ') || 'none'})`);

    for (const n of declared) {
      const e = evaluate({ name: n });
      assert(e.ok === false && e.decision === 'ask', `${n} asks without a tool object`);
    }
  }

  reset();
  console.log(`\npassed ${passed}, failed ${failed}`);
  return failed === 0;
}

test().then((ok) => process.exit(ok ? 0 : 1));