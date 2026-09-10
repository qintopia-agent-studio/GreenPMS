import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validatePullRequest } from './check-pr.mjs';

const scriptPath = fileURLToPath(new URL('./check-pr.mjs', import.meta.url));

function body(change, verification, risk) {
  return [
    '## 改动说明',
    '',
    change,
    '',
    '## 验证结果',
    '',
    verification,
    '',
    '## 风险与回退',
    '',
    risk,
  ].join('\n');
}

function runCli(eventText, eventPath) {
  fs.writeFileSync(eventPath, eventText, 'utf8');
  return spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    encoding: 'utf8',
  });
}

test('accepts English and Chinese pull requests', () => {
  assert.deepEqual(
    validatePullRequest({
      title: 'feat(web): add room search',
      body: body(
        'Adds room search to the operations view.',
        'npm test;未运行：原因：browser checks are not needed for this change.',
        'No known risk; revert the commit if needed.',
      ),
    }),
    [],
  );

  assert.deepEqual(
    validatePullRequest({
      title: 'fix(房态)!: 修复已入住状态',
      body: body('修复已入住客房的状态同步。', '未运行：原因是本次只调整校验规则。', '无'),
    }),
    [],
  );
});

test('rejects missing and duplicate required headings', () => {
  const missing = validatePullRequest({
    title: 'docs: update release notes',
    body: '## 改动说明\n\nUpdated the release notes.\n\n## 风险与回退\n\n无',
  });
  assert.ok(missing.includes('PR body must contain exactly one "## 验证结果" section.'));

  const duplicate = validatePullRequest({
    title: 'fix: correct validation',
    body: [
      '## 改动说明',
      '',
      'Corrects validation.',
      '## 验证结果',
      '',
      'node --test',
      '## 验证结果',
      '',
      'Repeated heading.',
      '## 风险与回退',
      '',
      '无',
    ].join('\n'),
  });
  assert.ok(duplicate.includes('PR body must contain exactly one "## 验证结果" section.'));
});

test('rejects comments-only, placeholder-only, and unchecked checklist content', () => {
  const errors = validatePullRequest({
    title: 'chore: tidy checks',
    body: body(
      '<!-- describe the change -->',
      '- [ ] TODO',
      'TBD',
    ),
  });

  assert.ok(errors.includes('PR body section "改动说明" must contain meaningful content.'));
  assert.ok(errors.includes('PR body section "验证结果" must contain meaningful content.'));
  assert.ok(errors.includes('PR body section "风险与回退" must contain meaningful content.'));
});

test('rejects invalid or meaningless Conventional Commit titles', () => {
  assert.ok(validatePullRequest({ title: 'feature: add search', body: body('change', 'test', '无') }).includes(
    'PR title must use Conventional Commit format.',
  ));
  assert.ok(validatePullRequest({ title: 'feat: ...', body: body('change', 'test', '无') }).includes(
    'PR title description must be meaningful.',
  ));
  assert.ok(validatePullRequest({ title: 'fix(scope with space): change', body: body('change', 'test', '无') }).includes(
    'PR title must use Conventional Commit format.',
  ));
});

test('ignores multiline template comments and headings inside comments', () => {
  const title = 'docs: update contribution guide';
  const comment = '<!--\n这里是模板提示\n## 改动说明\n-->';
  assert.ok(validatePullRequest({title, body: body(comment, '未运行：文档修改', '无')})
    .includes('PR body section "改动说明" must contain meaningful content.'));
  assert.deepEqual(validatePullRequest({title, body: body(`${comment}\n更新文档。`, '未运行：文档修改', '无')}), []);
});

test('CLI handles valid events and does not execute or leak malformed event content', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenpms-pr-'));
  const eventPath = path.join(tempDir, 'event.json');
  const sentinelPath = path.join(tempDir, 'injected');
  const injection = `$(touch ${sentinelPath})`;

  try {
    const valid = runCli(JSON.stringify({
      pull_request: {
        title: 'test: verify pull request checks',
        body: body('Adds validator coverage.', 'node --test scripts/check-pr-tests.mjs', '无'),
      },
    }), eventPath);
    assert.equal(valid.status, 0);
    assert.equal(valid.stdout, '');
    assert.equal(valid.stderr, '');

    const malformed = runCli(
      `{"pull_request":{"title":${JSON.stringify(injection)},"body":"unterminated",}}`,
      eventPath,
    );
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stdout, '');
    assert.equal(malformed.stderr, 'GitHub event payload is malformed JSON.\n');
    assert.equal(malformed.stderr.includes(injection), false);
    assert.equal(fs.existsSync(sentinelPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
