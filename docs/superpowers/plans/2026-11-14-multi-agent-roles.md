# Mỗi vai một agent: kế hoạch triển khai

> **Cho agent thực thi:** BẮT BUỘC dùng superpowers:subagent-driven-development (khuyên dùng) hoặc superpowers:executing-plans để làm từng task. Các bước dùng checkbox (`- [ ]`).

**Mục tiêu:** Lead, Worker, Reviewer chạy được bằng `codex`, `claude` hoặc `antigravity`. Đổi agent bằng lệnh. Agent hết token thì Human được báo và chuyển việc sang agent khác trên cùng worktree.

**Kiến trúc:** Luật đọc màn hình theo agent nằm trong một module thuần (`src/runtime/screens.ts`). Controller dùng nó để cứu brief chưa gửi và nhận ra câu báo hết hạn mức. Chuyển agent là một cặp event mới (`handoff-intended` → `owner-handed-off`). Bước chuyển dùng `orca orchestration worker-stop` rồi `worker-start --worktree id:<cũ>`. Resume tự mở terminal mới khi profile của vai đã đổi.

**Tech stack:** TypeScript (ESM), commander, vitest, Orca CLI.

**Spec:** `docs/design/multi-agent-roles.md`

## Ràng buộc chung

- Agent id đúng theo Orca: `codex`, `claude`, `antigravity`. Không có `runtime.json` thì mặc định giữ nguyên (`src/runtime/brief.ts:10-14`).
- Không đo token cho Claude/agy. `CodexSessionProbe` không đổi.
- Chuyển agent **không** tăng `soloAttempts` hay `PackageState.attempts`.
- Không mở agent mới khi `worker-stop` không chắc đã dừng agent cũ.
- Luật màn hình chỉ viết từ mẫu thật. Mẫu chưa có thì `quota()` trả `undefined` và ghi chú *chưa xác minh* trong code.
- Ngưỡng: `QUOTA_CHECK_IDLE_MINUTES = 2`, `OWNER_IDLE_MINUTES = 15` (giữ), `LEAD_IDLE_MINUTES = 20` (giữ).
- Lệnh mới (`profile set/reset`, `handoff`) đi qua `assertHuman` (`src/cli-app.ts:70`).
- Chạy test: `npx vitest run <file>`. Toàn bộ: `npm test` và `npm run typecheck`.

## Điểm cần soi kỹ

1. **Agent đang nói về giới hạn sử dụng trong output** (ví dụ làm tính năng rate limit). Không được báo hết token. Luật chỉ khớp câu nguyên mẫu của agent, chỉ xét khi dispatch im lặng ≥ 2 phút và màn hình không ở trạng thái `working`. Test ở Task 1.
2. **Tick của controller chạy giữa `worker-stop` và `owner-handed-off`.** Không được ghi `worker-settled failed`, `package-blocked` hay repair. Test ở Task 6.
3. **Lead sau khi chuyển agent rồi được đánh thức tiếp** (Multi-WP). Lượt đánh thức phải vào terminal **mới**, không phải terminal đã đóng. Test ở Task 6.
4. **`handoff --agent claude` cho Worker trong lúc Lead vẫn là Codex.** Chỉ profile `worker` đổi. Test ở Task 7.
5. **Resume sau khi đổi profile, với dispatch cũ đã settle.** Phải là terminal mới, có brief đầy đủ của vai, và không gọi `worker-stop`. Test ở Task 8.

---

### Task 1: Luật màn hình theo agent

**Files:**
- Create: `src/runtime/screens.ts`
- Create: `src/runtime/screens.test.ts`
- Create: `src/runtime/fixtures/screens/{codex,claude,antigravity}/*.txt`
- Modify: `src/runtime/orca.ts:442-449`. `composerHasUnsentBrief` thành lớp bọc gọi `SCREENS.codex.unsentBrief`.

**Interfaces:**
- Produces:
  ```ts
  export type AgentId = 'codex' | 'claude' | 'antigravity';
  export type ScreenRules = { working(lines: string[]): boolean; unsentBrief(lines: string[]): boolean; quota(lines: string[]): string | undefined };
  export const SCREENS: Record<AgentId, ScreenRules>;
  export function rulesFor(agent: string | undefined): ScreenRules[]; // agent lạ hoặc undefined → Object.values(SCREENS)
  export function unsentBrief(agent: string | undefined, lines: string[]): boolean; // không bộ luật nào thấy working, và ít nhất một bộ thấy unsent
  export function quotaMessage(agent: string | undefined, lines: string[]): string | undefined; // working → undefined; ngược lại trả dòng khớp đầu tiên, đã trim
  ```

- [ ] **Bước 1: Lấy mẫu màn hình thật.** Trong một repo Git tạm, chạy `orca orchestration run-create --objective "apos screen samples" --json`, rồi với mỗi agent `claude` và `antigravity`: `orca orchestration worker-start --spec "Reply OK and wait." --worktree new-top-level --repo path:<repo tạm> --agent <id> --run <run> --json`. Đọc `orca terminal read --terminal <handle> --json` (lấy `result.terminal.tail`) ở ba lúc: đang chạy, ô nhập rỗng chờ lệnh, và sau `orca terminal send --terminal <h> --text "<chuỗi 800 ký tự>"` (không `--enter`). Lưu mỗi lần thành một file `.txt` (một dòng tail mỗi dòng file): `working.txt`, `idle.txt`, `unsent.txt`. Nếu `worker-start` mở ra dạng chat (không có terminal handle), ghi điều đó vào `src/runtime/fixtures/screens/<agent>/README.md`. Khi đó `unsentBrief` của agent đó trả `false`, vì Orca tự nhận input. Dọn dẹp: `worker-stop` rồi `worktree rm`.

- [ ] **Bước 2: Ghi mẫu hết hạn mức đã biết.** Lấy từ `orca search "hit your limit" --scope all`:
  - `claude/quota-weekly.txt`: `You've hit your weekly limit · resets 1am (Asia/Ho_Chi_Minh)`
  - `claude/quota-5h.txt`: `You've hit your 5-hour limit · resets 12:20pm (Asia/Ho_Chi_Minh)`
  - `codex/quota.txt`: `■ You've hit your usage limit. Upgrade to Pro or try again in 2 hours 14 minutes.`

  Mẫu Codex phải đối chiếu lại bằng `orca search "hit your usage limit" --agent codex --scope all`. Không tìm được câu nguyên văn trên màn hình thì ghi chú *chưa xác minh* ở đầu file. agy: không có mẫu, nên tạo `antigravity/README.md` ghi "quota chưa xác minh; quota() trả undefined".

- [ ] **Bước 3: Viết test fail** trong `src/runtime/screens.test.ts`, đọc fixture bằng `readFileSync(...).split(/\r?\n/)`:
  ```ts
  it('codex keeps its existing rules', () => {
    expect(unsentBrief('codex', ['› [Pasted Content 7848 chars]', '  GPT-6.1 Terra medium'])).toBe(true);
    expect(unsentBrief('codex', ['• Working (50s • esc to interrupt)', '› Ask Codex to do anything'])).toBe(false);
  });
  it('claude and agy: unsent only on the unsent sample', () => {
    for (const agent of ['claude', 'antigravity']) {
      expect(unsentBrief(agent, fixture(agent, 'unsent'))).toBe(true);
      expect(unsentBrief(agent, fixture(agent, 'idle'))).toBe(false);
      expect(unsentBrief(agent, fixture(agent, 'working'))).toBe(false);
    }
  });
  it('names the quota line', () => {
    expect(quotaMessage('claude', fixture('claude', 'quota-weekly'))).toBe("You've hit your weekly limit · resets 1am (Asia/Ho_Chi_Minh)");
    expect(quotaMessage('claude', fixture('claude', 'quota-5h'))).toMatch(/5-hour limit/);
    expect(quotaMessage('codex', fixture('codex', 'quota'))).toMatch(/usage limit/);
    expect(quotaMessage('antigravity', fixture('claude', 'quota-weekly'))).toBeUndefined();
  });
  it('does not fire on an agent discussing limits or while working', () => {
    expect(quotaMessage('claude', ['  The API returns 429 when you hit your rate limit; add a retry.', '> '])).toBeUndefined();
    expect(quotaMessage('claude', [...fixture('claude', 'working'), "You've hit your weekly limit · resets 1am"])).toBeUndefined();
  });
  it('unknown agent tries every rule set', () => {
    expect(quotaMessage(undefined, fixture('claude', 'quota-weekly'))).toMatch(/weekly limit/);
  });
  ```
  Bỏ qua test `unsent` cho agent nào đã ghi "chat" ở Bước 1.

- [ ] **Bước 4: Chạy** `npx vitest run src/runtime/screens.test.ts`. Kỳ vọng FAIL (module chưa có).

- [ ] **Bước 5: Viết `src/runtime/screens.ts`.**
  - Luật Codex chuyển nguyên từ `orca.ts:443-449`.
  - Quota của Claude: `/^\s*[⎿●•■]?\s*You've hit your (weekly|5-hour|usage|session) limit\b/`. Bắt đầu dòng, nên câu nằm giữa văn bản của agent không khớp.
  - Quota của Codex: `/^\s*■?\s*You've hit your usage limit\b/`.
  - `working`/`unsentBrief` của Claude/agy viết từ fixture.
  - Đổi `composerHasUnsentBrief(lines)` trong `orca.ts` thành `return SCREENS.codex.unsentBrief(lines)`.

- [ ] **Bước 6: Chạy** `npx vitest run src/runtime/screens.test.ts src/app/supervisor.test.ts`. Kỳ vọng PASS.

- [ ] **Bước 7: Commit.** `git add src/runtime/screens.ts src/runtime/screens.test.ts src/runtime/fixtures src/runtime/orca.ts`, message `feat: per-agent terminal screen rules`.

### Task 2: Biết agent của từng dispatch, cứu brief theo agent

**Files:**
- Modify: `src/runtime/orca.ts`. `composerPending` nhận agent. `startPackage`/`startReviewer` trả `requested`. Thêm `agentQuota`.
- Modify: `src/app/packages.ts:9` (`PackageRuntimeRef.requested?`)
- Modify: `src/domain/transitions.ts:46` (`reviewDispatch.requested?`)
- Modify: `src/app/supervisor.ts:260-279` (`unstickDispatch` nhận `agent?`) và 5 nơi gọi (`86`, `214`, `334`, `459`, `494`). Hai nơi ghi `review-dispatched` (`supervisor.ts:423`, `437` và nhánh Solo tương ứng) lưu `requested`.
- Test: `src/runtime/orca.test.ts`, `src/app/supervisor.test.ts`

**Interfaces:**
- Consumes: `unsentBrief`, `quotaMessage` (Task 1).
- Produces:
  ```ts
  // RuntimeAdapter
  composerPending?(terminal: string, agent?: string): Promise<boolean>;
  agentQuota?(terminal: string, agent?: string): Promise<string | undefined>;
  // PackageRuntimeRef, ReviewerRef, GoalState.reviewDispatch: thêm  requested?: RuntimeProfile
  // supervisor.ts
  export async function dispatchAgent(runtime: RuntimeAdapter, dispatchId: string, requested?: { agent?: string }): Promise<string | undefined>; // requested.agent ?? launchReceipt(dispatchId).agent; lỗi → undefined
  unstickDispatch(store, runtime, now, input: { goalId; dispatchId; terminal?; since?; agent?: string })
  ```

- [ ] **Bước 1: Viết test fail.**
  - `orca.test.ts`: `startPackage` và `startReviewer` với profiles `{ worker: { agent: 'claude' }, reviewer: { agent: 'antigravity' } }` trả ref có `requested.agent` đúng.
  - `composerPending('term_1', 'claude')` với `terminal read` trả tail `fixture('claude','unsent')` thì ra `true`.
  - `agentQuota('term_1', 'claude')` với tail quota-weekly thì ra đúng câu đó.
  - `supervisor.test.ts`: copy test "stalled Codex input", đổi `ref.requested = { agent: 'claude' }` và screen thành fixture `claude/unsent`. Runtime giả gọi `unsentBrief(agent, screen)`. Kỳ vọng `nudged ctx_1 (1/3)` và runtime nhận được `agent === 'claude'`.

- [ ] **Bước 2: Chạy** `npx vitest run src/runtime/orca.test.ts src/app/supervisor.test.ts`. Kỳ vọng FAIL.

- [ ] **Bước 3: Cài đặt.**
  - `composerPending` gọi `unsentBrief(agent, tail)`. `agentQuota` gọi `quotaMessage(agent, tail)`, cùng cách đọc `terminal read` như `orca.ts:364`.
  - `unstickDispatch` truyền `input.agent` vào `composerPending`.
  - Mỗi nơi gọi tính agent bằng `dispatchAgent(runtime, dispatchId, ref.requested)`. Với Lead đang đánh thức thì dùng `state.lead?.ref.requested`.

- [ ] **Bước 4: Chạy** `npx vitest run src/runtime src/app`. Kỳ vọng PASS.

- [ ] **Bước 5: Commit**, message `feat: agent-aware composer rescue; remember each dispatch's agent`.

### Task 3: Lệnh `apos profile`

**Files:**
- Modify: `src/runtime/brief.ts:16-22`
- Modify: `src/cli-app.ts` (thêm nhóm lệnh `profile`)
- Test: `src/runtime/brief.test.ts`, `src/app/cli.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const KNOWN_AGENTS = ['codex', 'claude', 'antigravity'] as const;
  export type ProfileSource = 'default' | 'runtime.json';
  export function describeProfiles(home: string | undefined): Record<Role, RuntimeProfile & { source: ProfileSource }>;
  export function setProfile(home: string, roles: Role[], change: { agent: string; model?: string; effort?: string }): RuntimeProfiles; // ghi runtime.json (UTF-8, không BOM, JSON 2 dấu cách)
  export function resetProfile(home: string, roles: Role[]): RuntimeProfiles; // xoá khoá; file rỗng {} thì xoá file
  ```

- [ ] **Bước 1: Viết test fail** (`brief.test.ts`):
  ```ts
  it('setProfile replaces the role profile and drops the old model when the agent changes', () => {
    writeFileSync(join(home, 'runtime.json'), JSON.stringify({ lead: { agent: 'codex', model: 'gpt-6-luna', effort: 'high' } }));
    setProfile(home, ['lead'], { agent: 'claude' });
    expect(loadProfiles(home).lead).toEqual({ agent: 'claude' });
    expect(loadProfiles(home).worker).toEqual(DEFAULT_PROFILES.worker);
  });
  it('effort without model is refused', () => { expect(() => setProfile(home, ['worker'], { agent: 'codex', effort: 'high' })).toThrow(/--effort requires --model/); });
  it('reset all removes runtime.json', () => { setProfile(home, ['lead'], { agent: 'claude' }); resetProfile(home, ['lead', 'worker', 'reviewer']); expect(existsSync(join(home, 'runtime.json'))).toBe(false); });
  ```
  Trong `cli.test.ts`: `apos profile set all --agent claude` rồi `apos profile show` in ra cả ba vai `claude (runtime.json)`. `apos profile set lead --agent foo` vẫn ghi, kèm dòng cảnh báo có chữ `not a known agent`. Chạy `profile set` với `ORCA_TERMINAL_HANDLE` của một Lead thì bị từ chối (theo mẫu `asLead` ở `supervisor.test.ts:26`).

- [ ] **Bước 2: Chạy** `npx vitest run src/runtime/brief.test.ts src/app/cli.test.ts`. Kỳ vọng FAIL.

- [ ] **Bước 3: Cài đặt.**
  - Thêm các hàm trên.
  - CLI: `profile show`, `profile set <lead|worker|reviewer|all> --agent <id> [--model] [--effort]`, `profile reset [role|all]` (mặc định `all`). Home là `options.home ?? controllerHome(repo())`.
  - `show` in mỗi vai một dòng: `lead: claude model=… effort=… (runtime.json)`.

- [ ] **Bước 4: Chạy lại.** Kỳ vọng PASS.

- [ ] **Bước 5: Commit**, message `feat: apos profile show/set/reset`.

### Task 4: Báo hết token, mở rộng báo im lặng

**Files:**
- Modify: `src/app/supervisor.ts` (thay `noticeIdleOwner` bằng `watchDispatch`; gọi ở owner Solo `85`, reviewer Solo `214`, package `334`, reviewer Multi `459`, Lead đang đánh thức `494`)
- Modify: `src/app/lead.ts:117-119` (Lead đang lập plan: kiểm quota trước `lead-idle`)
- Modify: `src/ui/read-model.ts` (nếu inbox/UI lọc theo `kind`, thêm `agent-exhausted`)
- Test: `src/app/supervisor.test.ts`, `src/app/multi-supervisor.test.ts`, `src/app/lead.test.ts`

**Interfaces:**
- Consumes: `agentQuota`, `dispatchAgent` (Task 2), `inspect().idleMinutes`.
- Produces:
  ```ts
  export const QUOTA_CHECK_IDLE_MINUTES = 2;
  export async function watchDispatch(store: GoalRepository, runtime: RuntimeAdapter, now: () => number, input: {
    goalId: string; dispatchId: string; runId: string; repoPath: string; terminal?: string;
    role: 'lead' | 'worker' | 'reviewer'; requested?: RuntimeProfile; packageId?: string;
    idleNoticeMinutes?: number; // mặc định OWNER_IDLE_MINUTES; undefined = không báo idle (Lead planning tự báo)
    handoffHint: string;        // vd `apos handoff GOAL-1 --package WP-A --agent <other>`
  }): Promise<string[]>;
  // human-notified { kind: 'agent-exhausted', goalId, dispatchId, role, agent, model, packageId?, message, note }
  ```

- [ ] **Bước 1: Viết test fail** (`supervisor.test.ts`):
  ```ts
  it('names an exhausted agent once per dispatch, after two quiet minutes', async () => {
    // Solo đang executing, ref.requested = { agent: 'claude' }; inspect trả { state: 'live', idleMinutes: 1 } rồi 3
    // agentQuota trả "You've hit your weekly limit · resets 1am (Asia/Ho_Chi_Minh)"
    // idle 1 → không có notice; idle 3 → đúng một human-notified kind 'agent-exhausted', role 'lead', agent 'claude'
    // note chứa 'apos handoff GOAL-' và '--agent'; step lần nữa → không có notice mới
    // idle 20 → KHÔNG có 'owner-idle' cho dispatch này
  });
  it('still reports a silent owner without a quota line as owner-idle at 15 min', async () => { /* agentQuota → undefined; idle 16 → kind 'owner-idle' */ });
  ```
  `multi-supervisor.test.ts`: package `WP-A` đang chạy, `requested.agent='claude'`, quota khớp → notice có `packageId: 'WP-A'`, `role: 'worker'`, note chứa `--package WP-A`. Package im lặng 16 phút mà không có quota → `owner-idle` có `packageId`.
  `lead.test.ts`: Lead đang lập plan, quota khớp ở idle 3 → `agent-exhausted` với `role: 'lead'`, không phải `lead-idle`.

- [ ] **Bước 2: Chạy** `npx vitest run src/app/supervisor.test.ts src/app/multi-supervisor.test.ts src/app/lead.test.ts`. Kỳ vọng FAIL.

- [ ] **Bước 3: Cài `watchDispatch`.**
  - Gọi `runtime.inspect({ runId, taskId: '', dispatchId, owner: 'lead', repoPath })`, lấy `idleMinutes`. Lỗi thì trả `[]`.
  - Idle ≥ 2 phút, có `terminal` và chưa báo `agent-exhausted` cho dispatch này: gọi `agentQuota(terminal, agent)`. Khớp thì ghi notice và trả `[`${role} ${dispatchId} out of quota (${agent}); Human notified`]`.
  - Không khớp, có `idleNoticeMinutes`, idle ≥ ngưỡng và chưa báo `owner-idle`/`agent-exhausted`: ghi `owner-idle` với note như `supervisor.ts:70`, thêm `packageId`/`role`.
  - Gọi **trước** `unstickDispatch` ở cả 5 chỗ.
  - `lead.ts`: trong nhánh idle, gọi `runtime.agentQuota` khi idle ≥ 2 phút, dùng chung `notifyOnce` với kind `agent-exhausted`.

- [ ] **Bước 4: Chạy lại cả thư mục** `npx vitest run src/app src/ui`. Kỳ vọng PASS.

- [ ] **Bước 5: Commit**, message `feat: tell the Human which agent ran out of quota; idle notice for every dispatch`.

### Task 5: Adapter cho việc chuyển agent

**Files:**
- Modify: `src/runtime/brief.ts` (thêm `handoffBrief`)
- Modify: `src/runtime/orca.ts` (thêm `stopWorker`, `handoff`)
- Test: `src/runtime/brief.test.ts`, `src/runtime/orca.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // brief.ts
  export type HandoffKind = 'lead-plan' | 'solo-owner' | 'lead-multi' | 'worker';
  export function handoffBrief(input: BriefBase & { kind: HandoffKind; fromAgent?: string; goalVersion: number; attempt: number;
    packageId?: string; packageVersion?: number; owner?: string; outcome?: string; extra?: string; budget?: Budget }): string;
  // orca.ts (RuntimeAdapter, optional)
  stopWorker?(dispatchId: string): Promise<'stopped' | 'unknown'>;
  handoff?(input: { kind: HandoffKind; role: Role; repoPath: string; goalId: string; goalVersion: number; runId: string; worktreeId: string;
    baseCommit: string; idempotencyKey: string; attempt: number; fromAgent?: string; packageId?: string; packageVersion?: number;
    owner?: string; outcome?: string; extra?: string; budget?: Budget }): Promise<RuntimeRef>; // ref.requested = profile(role)
  ```

- [ ] **Bước 1: Viết test fail.**
  - `brief.test.ts`, với mỗi `kind`: brief chứa `skillLines` của đúng vai (`lead` hoặc `worker`), activation line, `APOS dispatch key: <key>.`, `APOS base commit: <base>.`, và câu `taking over from a previous agent` có kèm `git status` cùng `git log ${base}..HEAD`.
  - `solo-owner` chứa `soloReportPath(goalId, attempt)`. `worker` chứa `packageReportPath(...)`. `lead-multi` chứa `apos --repo "<repo>" package list <goalId>`. `extra` được nối vào qua `oneLine`.
  - `orca.test.ts`: `stopWorker('ctx_1')` gọi đúng `['orchestration','worker-stop','--dispatch','ctx_1']`. Kết quả `{ processAction: 'closed_agent_terminal' }` → `'stopped'`. Execute ném lỗi, hoặc trả `stop_unknown` → `'unknown'`.
  - `handoff({... role: 'worker' ...})` với profiles `{ worker: { agent: 'claude', model: 'm1' } }` gọi `worker-start` có `--worktree id:<worktreeId>`, `--run <runId>`, `--agent claude --model m1`, **không** có `--terminal`, **không** có `new-top-level`. Ref trả về có `requested: { agent: 'claude', model: 'm1' }`.

- [ ] **Bước 2: Chạy** `npx vitest run src/runtime/brief.test.ts src/runtime/orca.test.ts`. Kỳ vọng FAIL.

- [ ] **Bước 3: Cài đặt.**
  - `handoffBrief` ghép từ các mảnh sẵn có trong `brief.ts`: `WORKSPACE`, `skillLines`, `budgetLine`, `repoMarker`. Thông tin dài đưa qua `spill` (gọi trong `OrcaRuntime.handoff` cho `extra`).
  - `stopWorker` coi `'stopped'` chỉ khi `processAction === 'closed_agent_terminal'`, hoặc khi dispatch đã `completed`/`failed` theo `worker-show` gọi ngay sau đó.

- [ ] **Bước 4: Chạy lại.** Kỳ vọng PASS.

- [ ] **Bước 5: Commit**, message `feat: Orca handoff to a fresh agent on the same worktree`.

### Task 6: Event chuyển agent và các chốt chặn

**Files:**
- Modify: `src/domain/transitions.ts`
- Modify: `src/app/controller.ts:139-145`, `184-190` (bỏ qua settlement khi đang chuyển)
- Modify: `src/app/supervisor.ts` (`SoloSupervisor.step`, `MultiSupervisor.step`: trả sớm khi đang chuyển)
- Modify: `src/cli-app.ts:85` (`assertHuman` gom ref từ `owner-handed-off`)
- Test: `src/domain/transitions.test.ts`, `src/app/controller.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // GoalEventType thêm 'handoff-intended' | 'owner-handed-off'
  type HandoffTarget = { kind: 'lead' } | { kind: 'package'; packageId: string } | { kind: 'reviewer' };
  // GoalState.handoffIntent?: { key: string; target: HandoffTarget; from: string; at: string }
  // 'handoff-intended' data: { key, target, from /* dispatchId cũ */ }
  // 'owner-handed-off' data: { key, target, from, ref /* RuntimeRef | PackageRuntimeRef | reviewDispatch */, unblock?: boolean }
  // 'intent-abandoned' với key === handoffIntent.key → xoá handoffIntent
  export const handingOff = (state: GoalState): boolean => Boolean(state.handoffIntent);
  ```
- Reducer cho `owner-handed-off`:
  - `lead`: `lead.ref = { ...lead.ref, ...ref }`, `lead.current = ref.dispatchId`, `lead.settled = undefined`. `leadTerminal = { terminal: ref.terminal, worktree: lead.ref.worktree cũ, runId }`. Nếu `runtimeRef` là ref của Lead (Solo đang executing) thì `runtimeRef = currentLeadRef`. `soloAttempts` giữ nguyên.
  - `package`: `runtimeRef = ref`, `status = 'executing'`, `attempts` giữ nguyên, `blocker = undefined` khi `unblock`.
  - `reviewer`: `reviewDispatch = ref`.
  - `unblock` trên Goal (`status === 'blocked'`): `status = 'executing'`, `blocker = undefined`.
  - Luôn: `handoffIntent = undefined`.
- `handoff-intended` yêu cầu: không có `handoffIntent` đang mở, Goal ở `selected|planned|ready|executing|blocked`.

- [ ] **Bước 1: Viết test fail.**
  - `transitions.test.ts`: Solo executing (`soloAttempts: 2`) → `handoff-intended` → `owner-handed-off` (lead, ref terminal `term_9`). Kết quả: `soloAttempts === 2`, `runtimeRef.dispatchId === ref.dispatchId`, `leadTerminal.terminal === 'term_9'`, `handoffIntent === undefined`.
  - Package `attempts: 1` → handed off → vẫn `attempts: 1`, `status: 'executing'`.
  - `intent-abandoned` với key của handoff → `handoffIntent` bị xoá.
  - `handoff-intended` lần hai khi đang mở → ném lỗi `A handoff is already pending`.
  - `controller.test.ts`: Solo đang chuyển (`handoffIntent` mở), `inspect` trả `outcome: 'failed'`. Một `tick` **không** thêm `worker-settled`, không `blocked`, không `checkpointed`. Tương tự cho Multi: package đang chuyển không bị `package-blocked`.
  - **Điểm soi 3:** Multi Lead đã chuyển sang `term_9` → lượt `wakeLead` sau đó nhận `terminal: 'term_9'`.

- [ ] **Bước 2: Chạy** `npx vitest run src/domain/transitions.test.ts src/app/controller.test.ts`. Kỳ vọng FAIL.

- [ ] **Bước 3: Cài reducer và chốt chặn.**
  - `controller.ts`: bỏ qua `inspect`/`inspectPackage`/settle khi `handingOff(state)` và ref đó là `handoffIntent.from`.
  - Hai supervisor `step`: trả `[]` khi `handingOff(state)`.
  - `assertHuman`: thêm `'owner-handed-off'` vào danh sách event ở `cli-app.ts:85`, đọc `data.ref`.

- [ ] **Bước 4: Chạy** `npm test`. Kỳ vọng PASS.

- [ ] **Bước 5: Commit**, message `feat: handoff events; controller ignores a dispatch being handed off`.

### Task 7: `HandoffService` và lệnh `apos handoff`

**Files:**
- Create: `src/app/handoff.ts`
- Create: `src/app/handoff.test.ts`
- Modify: `src/cli-app.ts` (lệnh `handoff`)
- Modify: `src/runtime/telemetry.test.ts` (một test, xem Bước 1)

**Interfaces:**
- Consumes: `stopWorker`, `handoff` (Task 5). Event và `HandoffTarget` (Task 6). `setProfile` (Task 3).
- Produces:
  ```ts
  export class HandoffService {
    constructor(store: GoalRepository, runtime: RuntimeAdapter & Partial<PackageRuntime>, profiles: () => RuntimeProfiles);
    /** Trả dispatch mới. Ném lỗi kèm hướng dẫn khi không chuyển được. */
    handoff(goalId: string, target: HandoffTarget, repoPath: string): Promise<{ dispatchId: string; warning?: string }>;
  }
  ```
- Quy tắc của `handoff()`:
  1. Xác định dispatch hiện hành, `worktreeId`, `runId`, `baseCommit`, `kind` (`lead-plan` khi Goal `selected|planned|ready`, `solo-owner` khi Solo executing, `lead-multi` khi Multi executing, `worker` cho package) và `fromAgent` (`requested?.agent`). Reviewer: dừng cái cũ rồi gọi lại đường `startReviewer` sẵn có trên commit `reviewDispatch.commit`, ghi `owner-handed-off` với ref reviewer mới.
  2. Được nhận khi Goal `blocked` hoặc package `blocked` **chỉ khi** blocker sinh ra từ settle `failed` của chính dispatch đó: note bắt đầu bằng `needs-decision: owner reported failed on attempt` (`supervisor.ts:115`) hoặc `Worker reported failed on` (`supervisor.ts:339`). Khi đó đặt `unblock: true`. Block khác thì ném `Error('<id> is blocked for another reason: <note>')`.
  3. Ghi `handoff-intended`. Nếu dispatch chưa settle (`inspect().outcome` rỗng) thì gọi `stopWorker`. Kết quả `'unknown'` thì ghi `intent-abandoned` và ném `Error('Could not confirm the old agent stopped; check Orca (worker-show --dispatch <id>) before retrying')`.
  4. Gọi `runtime.handoff(...)`. Lỗi thì ghi `intent-abandoned` rồi ném lại lỗi, kèm `Run apos handoff again`.
  5. Ghi `owner-handed-off`. `warning = 'same agent and model as before'` khi `profiles()[role]` trùng `requested`.
- CLI: `apos handoff <goalId> [--package <id> | --reviewer] [--agent <id> [--model] [--effort]]`. Có `--agent` thì gọi `setProfile(home, [role], …)` trước (vai suy từ target: lead/worker/reviewer). In `handed off <goalId> to <agent> (<dispatchId>)` và cảnh báo nếu có.

- [ ] **Bước 1: Viết test fail** (`handoff.test.ts`, runtime giả ghi lại lệnh):
  ```ts
  it('stops the stuck owner and starts the role profile on the same worktree, without spending an attempt', async () => {
    // Solo executing, soloAttempts 1, ref ctx_1 requested codex; inspect → live; stopWorker → 'stopped'; handoff → ref ctx_2 term_2
    // kỳ vọng: calls theo thứ tự stopWorker(ctx_1), handoff({ kind: 'solo-owner', worktreeId cũ, runId cũ, attempt: 1, fromAgent: 'codex' })
    // state: runtimeRef.dispatchId ctx_2, soloAttempts 1, handoffIntent undefined
  });
  it('refuses to start a new agent when the old one may still run', async () => { /* stopWorker → 'unknown' → throws /Could not confirm/, không gọi handoff, có intent-abandoned */ });
  it('clears a block caused by that dispatch failing, but not other blocks', async () => { /* blocked 'needs-decision: owner reported failed on attempt 1 ...' → ok + unblocked; blocked 'needs-decision: attempt budget 3 spent' → throws /another reason/ */ });
  it('hands a package to its worker profile only', async () => { /* --package WP-A: handoff nhận role 'worker', kind 'worker', packageVersion, owner, outcome từ spec */ });
  ```
  Trong `cli.test.ts` (**điểm soi 4**): `apos handoff GOAL-1 --package WP-A --agent claude` → `loadProfiles(home).worker.agent === 'claude'`, còn `lead` vẫn là mặc định. Từ terminal Lead thì bị từ chối.
  Trong `telemetry.test.ts`: một rollout Codex trong worktree W với timestamp trước `since` của một dispatch Claude cũng trên W thì không được tính cho dispatch Claude (`usage()` trả `undefined`).

- [ ] **Bước 2: Chạy** `npx vitest run src/app/handoff.test.ts src/app/cli.test.ts src/runtime/telemetry.test.ts`. Kỳ vọng FAIL.

- [ ] **Bước 3: Cài `HandoffService` và lệnh CLI.**

- [ ] **Bước 4: Chạy** `npm test && npm run typecheck`. Kỳ vọng PASS.

- [ ] **Bước 5: Commit**, message `feat: apos handoff moves a stuck owner to another agent`.

### Task 8: Resume và đánh thức khi profile đã đổi

**Files:**
- Modify: `src/runtime/orca.ts` (`resumeSolo:289`, `resumePackage:265`, `wakeLead:388`)
- Modify: `src/app/supervisor.ts:501`, `src/app/lead.ts:82` (truyền `requested`, ghi `terminal` mới vào `lead-woken`)
- Test: `src/runtime/orca.test.ts`

**Interfaces:**
- Consumes: `handoffBrief` (Task 5).
- Produces:
  ```ts
  export function profileChanged(running: RuntimeProfile | undefined, wanted: RuntimeProfile): boolean; // running undefined → false (ref cũ, giữ hành vi cũ)
  // wakeLead input thêm: requested?: RuntimeProfile; goalVersion?: number; baseCommit?: string
  // wakeLead trả { dispatchId: string; terminal?: string; requested?: RuntimeProfile }
  // resumePackage trả ref có requested
  ```

- [ ] **Bước 1: Viết test fail** (**điểm soi 5**):
  - `resumeSolo` với `ref.requested = { agent: 'codex', model: 'x' }`, profiles `lead = { agent: 'claude' }` → `worker-start` **không** có `--terminal`, có `--worktree id:<cũ>`, `--agent claude`. Spec chứa `taking over from a previous agent` và finding. Không gọi `worker-stop`. Ref trả về có `requested.agent === 'claude'` và terminal mới.
  - Profile không đổi → vẫn `--terminal <cũ>` như hiện nay (test cũ giữ nguyên).
  - `resumePackage` và `wakeLead` có test tương tự. `wakeLead` khi đổi trả `terminal` mới, và `MultiSupervisor` ghi `lead-woken` có `terminal`/`worktree` để reducer cập nhật `leadTerminal` (`transitions.ts:385`).

- [ ] **Bước 2: Chạy** `npx vitest run src/runtime/orca.test.ts src/app/multi-supervisor.test.ts`. Kỳ vọng FAIL.

- [ ] **Bước 3: Cài đặt.** Trong mỗi hàm, nếu `profileChanged(ref.requested, this.profile(role))` thì gọi `this.handoff(...)` với `kind` tương ứng (`solo-owner`, `worker`, `lead-multi` hoặc `lead-plan` theo `phase`) và `extra` = nội dung mà lần resume hay đánh thức đó lẽ ra gửi (finding hoặc danh sách sự kiện). Ngược lại giữ đường cũ.

- [ ] **Bước 4: Chạy** `npm test`. Kỳ vọng PASS.

- [ ] **Bước 5: Commit**, message `feat: resumes and wakes use the role's current agent`.

### Task 9: Skill cho Codex/agy, tài liệu, chạy thật

**Files:**
- Modify: `src/app/init-project.ts:44-50`
- Test: `src/app/init-project.test.ts`
- Modify: `README.md` (bảng `runtime.json` ở dòng 293, mục Dispatch ở dòng 229, các lệnh mới, notice `agent-exhausted`)
- Modify: `src/runtime/README.md` (`worker-stop`, agent id `antigravity`, mẫu màn hình)

- [ ] **Bước 1: Viết test fail.** Sau `initProject`, cả `.claude/skills/apos-pm/SKILL.md` lẫn `.agents/skills/apos-pm/SKILL.md` tồn tại với cùng nội dung, và cả hai đều nằm trong commit `apos: initialize managed project`. File `.agents/...` đã có sẵn thì không bị ghi đè.

- [ ] **Bước 2: Chạy** `npx vitest run src/app/init-project.test.ts`. Kỳ vọng FAIL. **Bước 3:** Lặp ghi skill cho cả hai thư mục gốc `['.claude', '.agents']`. **Bước 4:** Chạy lại, kỳ vọng PASS.

- [ ] **Bước 5: Cập nhật hai README.** Ghi đúng các lệnh và notice như đã cài.

- [ ] **Bước 6: Chạy thật** (cần Orca và hạn mức của từng agent; ghi kết quả vào `report.md` hoặc một file evidence mới):
  1. `apos profile set all --agent claude`, rồi chạy một Goal Solo nhỏ tới `verified`.
  2. Làm lại với `antigravity`.
  3. Đang có Goal Solo chạy bằng Claude thì `apos handoff <goal> --agent codex`. Kiểm: worktree giữ nguyên commit và thay đổi chưa commit, Codex làm tiếp tới `verified`, `soloAttempts` không tăng.
  4. Mở Codex hoặc agy trong repo đã `apos init`, kiểm skill `apos-pm` được nhận.

  Bước nào không làm được (vì hết hạn mức hay thiếu agent) thì ghi rõ là chưa xác minh, không đánh dấu xong.

- [ ] **Bước 7: Chạy** `npm test && npm run typecheck`. Kỳ vọng PASS.

- [ ] **Bước 8: Commit**, message `feat: install role skills for Codex and agy; document multi-agent roles`.
