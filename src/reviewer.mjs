/**
 * LAC-12 + LAC-13: Reviewer Agent + Linear Integration
 *
 * One-shot: fetch PR diff → adversarial review → post GitHub comment → update Linear.
 *
 * Called by watcher.mjs as a child process:
 *   node src/reviewer.mjs '<JSON args>'
 *
 * Args JSON shape:
 *   { repo, prNumber, reviewerModel, botTokenEnv, linearTicketId }
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Adversarial prompt (NON-NEGOTIABLE) ──────────────────────────────────────

const ADVERSARIAL_PROMPT = `You are performing an adversarial code review. You did NOT write this code.

Your job is to find problems. Specifically:
- Bugs and edge cases the author missed
- Security vulnerabilities (injections, auth gaps, secret leakage, unsafe deps)
- Design flaws (wrong abstraction, fragile coupling, missing error handling)
- Performance issues
- Anything that would fail in production

Do NOT summarize what the code does. Do NOT praise. Be specific and direct.
For each issue: state the file, line(s), the problem, and the recommended fix.

If you find nothing substantive, say so plainly — but look hard first.`;

// ── Critical-issue detection ─────────────────────────────────────────────────

const CRITICAL_WORDS = ['critical', 'vulnerability', 'security', 'injection'];

function isCritical(reviewText) {
  const lower = reviewText.toLowerCase();
  return CRITICAL_WORDS.some((w) => lower.includes(w));
}

// ── PR diff fetch ────────────────────────────────────────────────────────────

async function fetchPRDiff(repo, prNumber) {
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'diff', String(prNumber), '--repo', repo],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout;
}

// ── AI review ───────────────────────────────────────────────────────────────

async function reviewWithClaude(diff) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `${ADVERSARIAL_PROMPT}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\n\`\`\``,
      },
    ],
  });

  return message.content[0].text;
}

async function reviewWithCodex(diff) {
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 4096,
    messages: [
      {
        role: 'system',
        content: ADVERSARIAL_PROMPT,
      },
      {
        role: 'user',
        content: `Here is the PR diff to review:\n\n\`\`\`diff\n${diff}\n\`\`\``,
      },
    ],
  });

  return response.choices[0].message.content;
}

// ── GitHub review posting ────────────────────────────────────────────────────

async function postGitHubReview(repo, prNumber, reviewBody, botTokenEnv) {
  const token = process.env[botTokenEnv];
  if (!token) {
    throw new Error(`Missing env var: ${botTokenEnv}`);
  }

  await execFileAsync(
    'gh',
    ['pr', 'review', String(prNumber), '--repo', repo, '--comment', '--body', reviewBody],
    {
      env: { ...process.env, GH_TOKEN: token },
      maxBuffer: 5 * 1024 * 1024,
    }
  );
}

// ── Linear integration (LAC-13) ──────────────────────────────────────────────

async function updateLinearTicket(ticketId, { reviewComplete, critical, reviewSummary }) {
  if (!ticketId || !process.env.LINEAR_API_KEY) return;

  const { LinearClient } = await import('@linear/sdk');
  const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

  let issue;
  try {
    issue = await linear.issue(ticketId);
  } catch (err) {
    console.error(`[reviewer] Linear: could not find issue ${ticketId}:`, err.message);
    return;
  }

  if (reviewComplete) {
    // Transition to "Done" / "Review Complete" state
    const team = await issue.team;
    const states = await team.states();
    const doneState = states.nodes.find((s) => {
      const name = s.name.toLowerCase();
      return name === 'review complete' || name === 'done';
    });
    if (doneState) {
      await linear.updateIssue(issue.id, { stateId: doneState.id });
      console.log(`[reviewer] Linear ${ticketId} → ${doneState.name}`);
    }
  }

  // Flag critical issues for Paul
  if (critical) {
    const flagComment =
      `⚠️ **Adversarial review flagged critical issues** — Paul, please review.\n\n` +
      `Issues detected: ${CRITICAL_WORDS.filter((w) => reviewSummary.toLowerCase().includes(w)).join(', ')}\n\n` +
      `Full review posted as a GitHub PR comment.`;

    await linear.createComment({ issueId: issue.id, body: flagComment });
    console.log(`[reviewer] Linear ${ticketId} — critical flag comment added`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv[2];
  if (!rawArgs) {
    console.error('[reviewer] Usage: node src/reviewer.mjs \'<JSON args>\'');
    process.exit(1);
  }

  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    console.error('[reviewer] Invalid JSON args:', rawArgs);
    process.exit(1);
  }

  const { repo, prNumber, reviewerModel, botTokenEnv, linearTicketId } = args;

  if (!repo || !prNumber || !reviewerModel || !botTokenEnv) {
    console.error('[reviewer] Missing required fields in args:', args);
    process.exit(1);
  }

  console.log(`[reviewer] Starting review: ${repo}#${prNumber} model=${reviewerModel}`);

  // 1. Fetch diff
  let diff;
  try {
    diff = await fetchPRDiff(repo, prNumber);
  } catch (err) {
    console.error(`[reviewer] Failed to fetch diff for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  if (!diff.trim()) {
    console.log(`[reviewer] Empty diff for ${repo}#${prNumber} — nothing to review`);
    process.exit(0);
  }

  // 2. Run adversarial review
  let reviewText;
  try {
    if (reviewerModel === 'claude') {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
      reviewText = await reviewWithClaude(diff);
    } else {
      if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
      reviewText = await reviewWithCodex(diff);
    }
  } catch (err) {
    console.error(`[reviewer] AI review failed for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  console.log(`[reviewer] Review generated (${reviewText.length} chars)`);

  // 3. Post to GitHub
  const header =
    reviewerModel === 'claude'
      ? '## Adversarial Review — Claude (claude-reviewer-lacey)\n\n'
      : '## Adversarial Review — Codex/GPT-4o (codex-reviewer-lacey)\n\n';
  const fullComment = header + reviewText;

  try {
    await postGitHubReview(repo, prNumber, fullComment, botTokenEnv);
    console.log(`[reviewer] Review posted to ${repo}#${prNumber}`);
  } catch (err) {
    console.error(`[reviewer] Failed to post review to ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  // 4. Update Linear (LAC-13)
  const critical = isCritical(reviewText);
  try {
    await updateLinearTicket(linearTicketId, {
      reviewComplete: true,
      critical,
      reviewSummary: reviewText,
    });
  } catch (err) {
    console.error(`[reviewer] Linear update failed for ${linearTicketId}:`, err.message);
    // Non-fatal — review was posted, just log and continue
  }

  if (critical) {
    console.log(`[reviewer] CRITICAL issues detected in ${repo}#${prNumber} — Paul flagged in Linear`);
  }

  console.log(`[reviewer] Done: ${repo}#${prNumber}`);
}

main().catch((err) => {
  console.error('[reviewer] Unhandled error:', err);
  process.exit(1);
});
