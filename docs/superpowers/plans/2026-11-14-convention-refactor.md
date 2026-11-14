# Thống nhất convention và dọn code: kế hoạch triển khai

> **Cho agent thực thi:** BẮT BUỘC dùng superpowers:subagent-driven-development (khuyên dùng) hoặc superpowers:executing-plans để làm từng task. Các bước dùng checkbox (`- [ ]`).

**Mục tiêu:** Máy giữ chuẩn code (format, lint, hướng phụ thuộc, CI). Dọn bốn điểm đang cản Multi-WP thật và owner Claude/Antigravity: `runtimeRef` kiểu `unknown`, vòng import runtime ↔ app, câu dựng event bị chép nhiều chỗ, file quá to. **Không đổi hành vi.**

**Kiến trúc:** Hướng phụ thuộc là `domain ← ports ← {store, runtime, app} ← {cli, ui}`. Kiểu dữ liệu ref của runtime chuyển xuống `domain/runtime-refs.ts`, interface cổng gom vào `src/ports/`. Đầu tiên thêm công cụ, các vi phạm hiện có ghi vào danh sách ngoại lệ, mỗi task sau gỡ phần của mình. Cuối plan danh sách ngoại lệ chỉ còn các ngoại lệ vĩnh viễn.

**Tech stack:** TypeScript 5.9 (ESM, NodeNext, import có đuôi `.js`), vitest 4.1.12, commander, zod; thêm Prettier, ESLint flat config + typescript-eslint, dependency-cruiser, @vitest/coverage-v8.

**Spec:** `docs/architecture/convention-refactor.md` (Đã duyệt 2026-11-14)

## Ràng buộc chung

- **Không đổi hành vi.** Mỗi task xong khi `npm run typecheck` và `npm test` pass (hiện 283 test), cộng các lệnh kiểm đã thêm ở task trước. Test cũ không được sửa assertion; chỉ được sửa đường dẫn import.
- **Event log JSONL là hợp đồng:** không đổi JSON ghi xuống đĩa, không thêm validate làm log cũ fail khi replay.
- Tên lệnh, cờ, output và `--help` của CLI giữ nguyên. `package.json` vẫn giữ `bin: ./dist/cli.js`, và `src/cli.ts` vẫn là entry point.
- Không dùng barrel file hay re-export để giữ đường dẫn cũ: chuyển code thì sửa mọi import.
- devDependency ghim đúng version (`--save-exact`), theo nếp `package.json` hiện có. Version đề xuất: `prettier@3.10.1`, `eslint@10.15.0`, `typescript-eslint@8.72.2`, `dependency-cruiser@18.7.2`, `@vitest/coverage-v8@4.1.12`. Version nào phát hành chưa đủ 14 ngày (`npm view <pkg> time`) thì lấy bản liền trước.
- Mỗi task một commit, tiền tố `chore:` (công cụ) hoặc `refactor:` (code), kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Dòng ≤ 120 ký tự (Prettier). File không phải test ≤ 400 dòng; ngoại lệ vĩnh viễn duy nhất là `src/domain/transitions.ts`.

## Trọng tâm review

1. **Log cũ (trước khi có event `lead-*`) phải replay ra đúng trạng thái như trước khi refactor.** Task 4 ghim; Task 5 và Task 6 phải giữ snapshot không đổi.
2. **`apos --help` và help của từng nhóm lệnh giữ đúng thứ tự và nội dung sau khi tách CLI.** Task 7 chụp snapshot help *trước* khi tách.
3. **Bản build chạy được:** `npm run build && node dist/cli.js --help` sau mỗi task có chuyển file (Task 3, 7, 8, 9, 10). Import sai đuôi `.js` chỉ lộ ra ở đây.
4. **HTML và CSS nhúng trong `src/ui/page.ts` không được đổi khi format.** Task 1 đặt `embeddedLanguageFormatting: "off"` và chạy `src/ui/ui.test.ts`.
5. **CI trên Windows:** test git subprocess chậm (`vitest.config.ts` đặt `testTimeout: 20000`). CI dùng `windows-latest` để bắt đúng loại lỗi này. Task 2 xác minh lần chạy CI đầu tiên xanh.

---

### Task 1: Prettier và reformat toàn repo (Đ0)

**Files:**
- Create: `.prettierrc.json`, `.prettierignore`, `.git-blame-ignore-revs`
- Modify: `package.json` (devDep, scripts), mọi file `*.ts`/`*.mjs`/`*.json` do Prettier sửa

**Interfaces:**
- Produces: scripts `format` = `prettier --write .`, `format:check` = `prettier --check .`

- [ ] **Bước 1:** `npm i -D --save-exact prettier@3.10.1`
- [ ] **Bước 2:** Tạo `.prettierrc.json`:
  ```json
  { "printWidth": 120, "singleQuote": true, "trailingComma": "all", "arrowParens": "avoid", "endOfLine": "lf", "embeddedLanguageFormatting": "off" }
  ```
  và `.prettierignore` gồm `dist/`, `node_modules/`, `package-lock.json`, `src/runtime/fixtures/`, `*.md`. Bỏ markdown để không đụng docs đã duyệt.
- [ ] **Bước 3:** Thêm hai script `format` và `format:check` vào `package.json`.
- [ ] **Bước 4:** `npm run format`, rồi `git diff --stat`. Kỳ vọng: chỉ file code/config đổi, không có file `.md`, không có `src/runtime/fixtures/`.
- [ ] **Bước 5:** `npm run typecheck && npm test`. Kỳ vọng: pass hết, gồm `src/ui/ui.test.ts`.
- [ ] **Bước 6:** `npm run format:check`. Kỳ vọng: `All matched files use Prettier code style!`
- [ ] **Bước 7:** Commit `chore: add prettier and format the codebase`. Sau đó ghi hash của commit đó vào `.git-blame-ignore-revs` (một dòng chú thích `# prettier reformat` rồi đến hash), commit tiếp `chore: ignore the prettier reformat in git blame`.

### Task 2: ESLint, dependency-cruiser, CI, AGENTS.md (Đ1)

**Files:**
- Create: `eslint.config.js`, `.dependency-cruiser.cjs`, `.github/workflows/ci.yml`, `AGENTS.md`, `CLAUDE.md`
- Modify: `package.json`

**Interfaces:**
- Produces: scripts `lint` = `eslint .`, `deps:check` = `depcruise src --config .dependency-cruiser.cjs`, `check` = `npm run format:check && npm run lint && npm run deps:check && npm run typecheck && npm test`. Các task sau chạy `npm run check`.
- Produces: trong `eslint.config.js` có mảng `TEMPORARY_EXCEPTIONS` (file + luật + task sẽ gỡ). Trong `.dependency-cruiser.cjs` các vi phạm tạm ghi bằng `pathNot`, mỗi dòng kèm chú thích `// gỡ ở Task N`.

- [ ] **Bước 1:** `npm i -D --save-exact eslint@10.15.0 typescript-eslint@8.72.2 dependency-cruiser@18.7.2`
- [ ] **Bước 2:** Viết `eslint.config.js` (flat config, `tseslint.configs.recommended`, bỏ qua `dist/`) với các luật:
  - `@typescript-eslint/no-explicit-any: error`
  - `@typescript-eslint/consistent-type-imports: error`
  - `max-lines: ['error', { max: 400, skipBlankLines: true, skipComments: true }]`, chỉ áp cho file không phải `*.test.ts`
  - `no-restricted-syntax` với hai selector, mỗi cái kèm message:
    - `TSAsExpression > TSAsExpression[typeAnnotation.type='TSUnknownKeyword']`: "Không dùng `as unknown as`; thu hẹp kiểu bằng type guard."
    - `ObjectExpression:has(Property[key.name='id'] > CallExpression[callee.name='randomUUID']):has(Property[key.name='goalId'])`: "Tạo event bằng `newEvent()` trong `src/app/events.ts`."

  Ngoại lệ vĩnh viễn: `max-lines` tắt cho `src/domain/transitions.ts`, chú thích "một reducer, xem docs/architecture/convention-refactor.md O8". `TEMPORARY_EXCEPTIONS` là những gì `npm run lint` báo lúc này. Kỳ vọng tối thiểu gồm: `max-lines` cho `src/cli-app.ts` (gỡ ở Task 7), `src/app/supervisor.ts` (Task 8), `src/runtime/orca.ts` (Task 9); `no-explicit-any` cho `src/cli-app.ts` (Task 7); `as unknown as` cho `src/domain/transitions.ts` (Task 5); luật event cho 14 file dựng event (Task 6). Luật thuộc bộ `recommended` mà báo lỗi ở code hiện tại thì cũng vào `TEMPORARY_EXCEPTIONS`, ghi "gỡ ở Task 10".
- [ ] **Bước 3:** Viết `.dependency-cruiser.cjs` với các luật `forbidden` (severity `error`):
  - `no-circular`. Tạm thời `pathNot` cho vòng `src/runtime/orca.ts` ↔ `src/app/packages.ts` (gỡ ở Task 3). Vòng chỉ có type trong `src/domain/` thì để vĩnh viễn: `viaOnly` / `dependencyTypesNot: ['type-only']` giới hạn trong `^src/domain/`.
  - `domain-pure`: `from ^src/domain/` không được tới `^src/(ports|store|runtime|app|cli|ui)/` hay `^src/cli`.
  - `ports-only-domain`: `from ^src/ports/` chỉ được tới `^src/domain/`.
  - `runtime-store-no-app`: `from ^src/(runtime|store)/` không được tới `^src/(app|cli|ui)/`. Tạm `pathNot` cho `src/runtime/orca.ts` (gỡ ở Task 3).
  - `ui-read-only`: `from ^src/ui/` không được tới `^src/(app|runtime)/`, trừ `src/app/inbox.ts` và `src/runtime/orca` (vĩnh viễn, O10).
  - Không áp các luật trên cho `*.test.ts`. Test được import chéo, ví dụ `../cli.js`.
- [ ] **Bước 4:** Thêm scripts `lint`, `deps:check`, `check`. Chạy `npm run check`. Kỳ vọng: xanh. Đỏ thì chỉ được thêm vào danh sách ngoại lệ, không sửa code.
- [ ] **Bước 5:** Kiểm luật có tác dụng thật: tạm thêm `import type { ProjectJournal } from '../store/journal.js';` vào `src/domain/packages.ts` → `npm run deps:check` phải báo lỗi `domain-pure`. Bỏ dòng đó.
- [ ] **Bước 6:** `.github/workflows/ci.yml`: chạy trên `push` và `pull_request`, `runs-on: windows-latest`, `actions/checkout@v4`, `actions/setup-node@v4` với `node-version: 24` và `cache: npm`, rồi `npm ci`, `npm run check`, `npm run build`, `npm run skills:check`.
- [ ] **Bước 7:** `AGENTS.md` ở gốc repo, ngắn gọn, gồm: hướng phụ thuộc (sơ đồ ở mục 5 của spec); chỗ đặt từng loại code (bảng mục 6 của spec, kể cả `UserError`/`InvariantError` chỉ cho code mới); "chạy `npm run check` trước mỗi commit"; "không thêm vào `TEMPORARY_EXCEPTIONS`, chỉ gỡ ra". `CLAUDE.md` chỉ một dòng: `Đọc và theo AGENTS.md.`
- [ ] **Bước 8:** Commit `chore: lint, dependency rules, CI and agent conventions`. Sau khi push, `gh run watch` phải kết thúc với `completed success`. Đỏ vì timeout trên Windows thì dừng lại báo anh, không nâng timeout tùy tiện.

### Task 3: Kiểu ref xuống domain, interface cổng vào `ports/` (Đ2)

**Files:**
- Create: `src/domain/runtime-refs.ts`, `src/ports/runtime.ts`, `src/ports/commit-inspector.ts`, `src/ports/telemetry.ts`, `src/ports/goal-repository.ts`
- Modify: `src/runtime/brief.ts:7-10,86,180`, `src/runtime/orca.ts:7,11-64`, `src/app/packages.ts:10-16`, `src/app/integration.ts:11-15`, `src/runtime/telemetry.ts:5-6`, `src/store/journal.ts:10-19`, mọi file import các kiểu này (khoảng 17 file dùng `GoalRepository`, cùng các file trong danh sách `RuntimeAdapter|RuntimeRef`)
- Modify: `.dependency-cruiser.cjs` (gỡ 2 ngoại lệ của Task 2)

**Interfaces:**
- Produces, `src/domain/runtime-refs.ts` (chỉ chứa type, chuyển nguyên văn, không đổi trường): `Role`, `RuntimeProfile`, `RuntimeProfiles`, `Budget`, `HandoffKind` (từ `brief.ts`); `RuntimeRef`, `ReviewerRef`, `LaunchReceipt` (từ `orca.ts`); `PackageRuntimeRef` (từ `app/packages.ts`).
- Produces, `src/ports/runtime.ts`: `RuntimeAdapter`, `RuntimeObservation`, `OrcaMessage`, `OrcaDelivery`, `LeadInput`, `HandoffInput`, `WakeInput` (từ `orca.ts`); `PackageRuntime` (từ `app/packages.ts`). Chỉ import từ `../domain/`.
- Produces: `ports/commit-inspector.ts` chứa `CommitInspector`; `ports/telemetry.ts` chứa `Usage`, `TelemetryProbe`; `ports/goal-repository.ts` chứa `GoalRepository`. Các class cài đặt (`GitCommitInspector`, `CodexSessionProbe`, `ProjectJournal`, `OrcaRuntime`) ở yên chỗ cũ và `implements` interface từ `ports/`.

- [ ] **Bước 1:** Gỡ hai `pathNot` của Task 3 trong `.dependency-cruiser.cjs`, chạy `npm run deps:check`. Kỳ vọng: FAIL, báo vòng `orca.ts` ↔ `packages.ts` và lỗi `runtime-store-no-app`.
- [ ] **Bước 2:** Tạo các file ở mục Interfaces, chuyển định nghĩa sang, xóa bản cũ, sửa import ở mọi nơi dùng. Dùng `import type` cho import chỉ có type.
- [ ] **Bước 3:** `npm run check`. Kỳ vọng: xanh, `deps:check` không còn vòng import nào ngoài `src/domain/`.
- [ ] **Bước 4:** `npm run build && node dist/cli.js --help`. Kỳ vọng: in help, exit 0.
- [ ] **Bước 5:** Commit `refactor: move runtime refs to domain and port interfaces to src/ports`.

### Task 4: Ghim hành vi replay event log (Đ3a)

**Files:**
- Modify: `src/test-setup.ts:6`
- Create: `scripts/capture-replay-fixtures.mjs`, `src/store/fixtures/replay/<case>/events/GOAL-*.jsonl`, `src/store/replay-compat.test.ts`, `src/store/__snapshots__/replay/<case>.json`

**Interfaces:**
- Consumes: `ReadOnlyJournal` (`src/store/readonly-journal.ts`): `new ReadOnlyJournal(home)`, `.failures: Map<string,string>`, `.listGoals()`. Hàm `chain` trong `src/store/event-log.ts:20`: sha256(prev + JSON.stringify(event)), genesis là `'0'.repeat(64)`.
- Produces: `node scripts/capture-replay-fixtures.mjs <apos-home-nguồn> <tên-case>`. Script đọc `<home>/projects/*/events/*.jsonl`, thay đường dẫn máy trong mọi chuỗi bằng `/fixture` (tìm theo các tiền tố `C:/Users/`, `C:\\Users\\`, thư mục tạm của hệ điều hành, và đường dẫn repo nguồn), **tính lại chuỗi hash**, rồi ghi vào `src/store/fixtures/replay/<tên-case>/events/`.

- [ ] **Bước 1:** Sửa `src/test-setup.ts:6` thành `process.env.APOS_HOME = process.env.APOS_TEST_HOME ?? mkdtempSync(join(tmpdir(), 'apos-home-'));`. Không đổi gì khi biến môi trường không được đặt.
- [ ] **Bước 2:** Viết script ở mục Interfaces.
- [ ] **Bước 3: Gom log thật.** `~/.apos/projects` đang trống. Dùng 3 log smoke thật còn trên máy (định dạng trước khi có event `lead-*`), nằm ở `C:/Users/thien/AppData/Local/Temp/claude/f955c312cacd8afc/c9650458-39e8-4897-bb69-6c63979e2a01/scratchpad/apos-smoke-home` và `.../apos-smoke2-home`. Chạy script với case tên `legacy-solo` cho mỗi home. Nếu lúc thi công các thư mục này đã mất thì ghi lại điều đó trong commit message và chỉ dùng log sinh ở Bước 4.
- [ ] **Bước 4: Sinh log cho các luồng mới.** Đặt `APOS_TEST_HOME` = một thư mục scratch trống, chạy `npx vitest run src/app/multi-supervisor.test.ts src/app/handoff.test.ts src/app/review-fixes.test.ts src/app/lead.test.ts`. Mỗi test dùng một repo riêng nên log không trộn nhau. Chạy script với case tên `multi-wp`, `handoff`, `review`, `lead`, chỉ lấy project nào có event thuộc đúng luồng đó (`package-*`, `owner-handed-off`, `review-*`, `lead-*`). Kiểm: `grep -rE 'C:[/\\\\]|AppData|thien' src/store/fixtures/replay` không ra gì.
- [ ] **Bước 5:** Viết test `src/store/replay-compat.test.ts`:
  ```ts
  describe('event log replay compatibility', () => {
    for (const name of readdirSync(FIXTURES)) {
      it(`replays ${name} to the pinned state`, async () => {
        const journal = new ReadOnlyJournal(join(FIXTURES, name));
        expect([...journal.failures]).toEqual([]);
        expect(journal.listGoals().length).toBeGreaterThan(0);
        await expect(JSON.stringify(journal.listGoals(), null, 2)).toMatchFileSnapshot(`./__snapshots__/replay/${name}.json`);
      });
    }
  });
  ```
- [ ] **Bước 6:** `npx vitest run src/store/replay-compat.test.ts` hai lần. Lần đầu ghi snapshot; lần hai pass mà không ghi gì mới.
- [ ] **Bước 7:** `npm run check`, rồi commit `test: pin event log replay against real and generated logs`.

### Task 5: Gán kiểu cho `GoalState`, bỏ ép kiểu (Đ3)

**Files:**
- Modify: `src/domain/transitions.ts:16,25,29,30,59` (`PackageState`, `GoalState`, `LeadState`) và `:443`
- Modify: các file có ép kiểu `runtimeRef as`, `blocker as`, `checkpoint as`, `requested as`: `src/app/controller.ts`, `src/app/gate.ts`, `src/app/handoff.ts`, `src/app/lead.ts`, `src/app/solo.ts`, `src/app/supervisor.ts`, cùng các file `grep` còn tìm ra
- Modify: `eslint.config.js` (gỡ ngoại lệ `as unknown as` của transitions)

**Interfaces:**
- Consumes: `RuntimeRef`, `ReviewerRef`, `PackageRuntimeRef`, `RuntimeProfile` từ `src/domain/runtime-refs.ts` (Task 3); `PhaseCheckpoint` từ `src/domain/contracts.ts:147`.
- Produces: `GoalState.runtimeRef?: RuntimeRef`, `GoalState.checkpoint?: PhaseCheckpoint`, `GoalState.blocker?: Blocker` (với `export type Blocker = PackageBlocker` trong transitions), `PackageState.runtimeRef?: PackageRuntimeRef`, `LeadState.ref.requested?: RuntimeProfile`.
- Quy tắc: dữ liệu event (`unknown`) chỉ được thu hẹp kiểu **bên trong `applyEvent`**, bằng một hàm `const asRef = <T>(value: unknown): T => value as T;` ở đầu file, kèm chú thích "replay không validate: log cũ phải replay nguyên trạng". Không thêm zod hay `requireThat` mới.

- [ ] **Bước 1:** Đổi kiểu như mục Interfaces. Chạy `npm run typecheck`. Kỳ vọng: lỗi ở các chỗ gán trong `applyEvent`.
- [ ] **Bước 2:** Sửa các chỗ gán trong `applyEvent` bằng `asRef<…>(…)`. Dòng `:443` thành `asRef<GoalState['reviewDispatch']>(data.ref)`.
- [ ] **Bước 3:** Xóa mọi ép kiểu ngoài domain. Chạy `grep -rnE "(runtimeRef|blocker|checkpoint|requested) as " src --include=*.ts | grep -v test`. Kỳ vọng: không ra gì. Chỗ nào gán ref của reviewer vào trường kiểu `RuntimeRef` mà typecheck báo lệch thì **dừng lại báo**; đó là lỗi kiểu thật, ghi vào mục 8 của spec, không ép cho qua.
- [ ] **Bước 4:** Gỡ ngoại lệ `as unknown as` trong `eslint.config.js`. Chạy `npm run check`. Kỳ vọng: xanh, `replay-compat.test.ts` pass mà **không cập nhật snapshot**.
- [ ] **Bước 5:** Commit `refactor: type runtime refs in GoalState and drop the casts`.

### Task 6: Helper `newEvent` (Đ4)

**Files:**
- Create: `src/app/events.ts`, `src/app/events.test.ts`
- Modify: 14 file dựng event: `src/app/{controller,gate,handoff,integration,lead,merge,packages,registry,review,solo,supervisor,verification,watch}.ts`, `src/cli-app.ts:67`
- Modify: `eslint.config.js` (gỡ ngoại lệ luật event; chỉ `src/app/events.ts` được miễn)

**Interfaces:**
- Produces: `export function newEvent(goalId: string, type: GoalEventType, data?: unknown, at: string = new Date().toISOString()): GoalEvent`. Trả về `{ id: randomUUID(), goalId, type, data, at }`; khi `data === undefined` thì không có khóa `data` trong object.
- Chỗ gọi đang tính `at` riêng thì truyền vào: `new Date(this.now()).toISOString()`, `this.now()` (trong `app/gate.ts`, đã là chuỗi), `new Date(now()).toISOString()`.

- [ ] **Bước 1:** Viết test `src/app/events.test.ts`:
  ```ts
  it('builds an event with a fresh id and the given time', () => {
    const e = newEvent('GOAL-1', 'decision-logged', { note: 'x' }, '2026-11-14T00:00:00.000Z');
    expect(e).toMatchObject({ goalId: 'GOAL-1', type: 'decision-logged', data: { note: 'x' }, at: '2026-11-14T00:00:00.000Z' });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('omits data when none is given', () => {
    expect('data' in newEvent('GOAL-1', 'goal-selected')).toBe(false);
  });
  ```
- [ ] **Bước 2:** `npx vitest run src/app/events.test.ts`. Kỳ vọng: FAIL, lỗi không tìm thấy module.
- [ ] **Bước 3:** Viết `newEvent`, chạy lại test. Kỳ vọng: PASS.
- [ ] **Bước 4:** Thay 32 chỗ dựng event. Helper cục bộ `record(...)` và `event(...)` trong `cli-app.ts`/`packages.ts` gọi `newEvent` thay vì tự dựng object.
- [ ] **Bước 5:** Gỡ ngoại lệ luật event. Chạy `npm run check`. Kỳ vọng: xanh, snapshot replay không đổi.
- [ ] **Bước 6:** Commit `refactor: build goal events through newEvent`.

### Task 7: Tách `cli-app.ts` (Đ5)

**Files:**
- Create: `src/cli/context.ts`, `src/cli/commands/{setup,goal,lead,package,integration,controller,checks,outcome}.ts`, `src/cli-help.test.ts`
- Modify: `src/cli-app.ts`
- Modify: `eslint.config.js` (gỡ `max-lines` và `no-explicit-any` của `cli-app.ts`)

**Interfaces:**
- Produces, `src/cli/context.ts`: `export type CliContext = { program: Command; options: CliOptions; write(line: string): void; runtime: RuntimeAdapter & Partial<PackageRuntime>; packageRuntime(): PackageRuntime; repo(): string; home(): string; withJournal<T>(fn: (j: ProjectJournal) => T): T; withJournalAsync<T>(fn: (j: ProjectJournal) => Promise<T>): Promise<T>; assertHuman(journal: ProjectJournal, command: string): void; goalWithSource(file: string, sourcePath: string, origin: string): unknown; readJsonFile(file: string): unknown }` và `export function createContext(program: Command, options: CliOptions): CliContext`. Các hàm đang khai báo trong `runCli` ở `cli-app.ts:44-104,111-122` chuyển vào đây, giữ nguyên thân hàm. `readJsonFile` đổi kiểu trả về từ `any` sang `unknown`; chỗ gọi đưa kết quả qua hàm `parseX` sẵn có.
- Produces: mỗi file `commands/*.ts` export `register<Tên>(ctx: CliContext): void`. Chia theo `cli-app.ts`:
  - `setup` gồm `init`, `migrate`, `profile` (106-137)
  - `goal` (138-181)
  - `lead` gồm `lead` và `execution` (182-279; giữ nguyên thứ tự đăng ký, kể cả `lead commit` nằm sau `execution` được tạo)
  - `package` (280-325)
  - `integration` (326-347)
  - `controller` (348-385)
  - `checks` gồm `gate`, `review`, `metrics`, `evidence`, `decision`, `blocker` (386-429)
  - `outcome` gồm `handoff`, `outcome`, `inbox`, `ui`, `finding` (430-489)
- Giữ: `src/cli-app.ts` export `runCli(argv, options)` và `CliOptions` với chữ ký như cũ. `runCli` tạo `program`, gọi `createContext`, gọi các `register*` theo đúng thứ tự trên, rồi parse.

- [ ] **Bước 1: Ghim help trước khi tách.** Viết `src/cli-help.test.ts`, dùng `runCli([...args], { write, home })` theo mẫu của `src/cli.test.ts`. Với `--help` và `<nhóm> --help` cho mọi nhóm (`profile goal lead execution package integration controller gate review metrics evidence decision blocker outcome finding`), so output với `toMatchFileSnapshot('./__snapshots__/cli-help/<nhóm>.txt')`. commander in help ra `stdout` rồi gọi `process.exit`; test dùng `program.exitOverride()` nếu `runCli` đã hỗ trợ, nếu chưa thì `vi.spyOn(process.stdout, 'write')` và `vi.spyOn(process, 'exit')`, giống cách `cli-friendly.test.ts` đang làm.
- [ ] **Bước 2:** Chạy `npx vitest run src/cli-help.test.ts` hai lần trên code **chưa tách**. Lần hai pass mà không ghi snapshot mới. Commit riêng: `test: pin CLI help output`.
- [ ] **Bước 3:** Tạo `context.ts` và các file `commands/*.ts`, chuyển code sang, rút `cli-app.ts` còn `runCli`.
- [ ] **Bước 4:** Gỡ hai ngoại lệ của `cli-app.ts`. Chạy `npm run check`. Kỳ vọng: xanh, snapshot help và replay không đổi, mọi file mới ≤ 400 dòng.
- [ ] **Bước 5:** `npm run build && node dist/cli.js goal --help`. Kỳ vọng: giống snapshot `goal.txt`.
- [ ] **Bước 6:** Commit `refactor: split the CLI into per-group command modules`.

### Task 8: Tách `supervisor.ts` (Đ6, phần 1)

**Files:**
- Create: `src/app/solo-supervisor.ts`, `src/app/multi-supervisor.ts`, `src/app/supervision.ts`
- Delete: `src/app/supervisor.ts`
- Modify: các file import `./supervisor.js` hoặc `../app/supervisor.js` (gồm `src/app/controller.ts` và các test `supervisor`, `watch`, `dead-session`, `review-fixes`)

**Interfaces:**
- Produces: `solo-supervisor.ts` chứa `SoloSupervisor` và `SupervisorOptions`; `multi-supervisor.ts` chứa `MultiSupervisor`; `supervision.ts` chứa `unstickDispatch` (export) và các helper dùng chung `foreignCommits`, `remaining`, `describe` (chỉ export những gì hai class cần).

- [ ] **Bước 1: Đo độ phủ test.** `npm i -D --save-exact @vitest/coverage-v8@4.1.12`, rồi chạy `npx vitest run --coverage --coverage.include=src/app/supervisor.ts --coverage.include=src/runtime/orca.ts`. Ghi % lines vào commit message. File nào dưới 60% thì **dừng lại báo anh**: file đó chuyển sang `refactor-wave` theo mục 10 của spec, không tách ở plan này.
- [ ] **Bước 2:** Chuyển code sang ba file mới, xóa `supervisor.ts`, sửa import.
- [ ] **Bước 3:** Gỡ ngoại lệ `max-lines` của `supervisor.ts`. Chạy `npm run check`. Kỳ vọng: xanh.
- [ ] **Bước 4:** `npm run build && node dist/cli.js controller --help`. Kỳ vọng: exit 0.
- [ ] **Bước 5:** Commit `refactor: split Solo and Multi supervisors into their own modules`.

### Task 9: Tách `orca.ts` (Đ6, phần 2)

**Files:**
- Create: `src/runtime/orca/adapter.ts`, `src/runtime/orca/parse.ts`, `src/runtime/orca/exec.ts`, `src/runtime/orca/git.ts`
- Delete: `src/runtime/orca.ts`
- Move: `src/runtime/orca.test.ts` thành `src/runtime/orca/adapter.test.ts`
- Modify: mọi file import `runtime/orca.js`, kể cả `src/ui/activity.ts:5`. Ngoại lệ `ui-read-only` trong `.dependency-cruiser.cjs` đổi đường dẫn sang `src/runtime/orca/`.

**Interfaces:**
- Produces: `exec.ts` chứa `OrcaRefused`, `runOrca`; `parse.ts` chứa `parseOrcaResult`, `extractStartedRef`, `interpretWorkerShow`, `idleMinutesFrom`, `terminalWorktree`, `profileChanged`, `composerHasUnsentBrief`, cùng các helper riêng `object`, `id`, `runIdOf`, `assigneeOf`; `git.ts` chứa `composeBase`, `gitOk`; `adapter.ts` chứa `OrcaRuntime` và `worktreePath`. `worktreePath` để cùng chỗ với nơi nó đang được định nghĩa: nếu là method thì ở `adapter.ts`, nếu là hàm tự do thì ở `parse.ts`.

- [ ] **Bước 1:** Chuyển code, xóa `orca.ts`, chuyển file test, sửa import.
- [ ] **Bước 2:** Gỡ ngoại lệ `max-lines` của `orca.ts`. Chạy `npm run check`. Kỳ vọng: xanh, mọi file ≤ 400 dòng.
- [ ] **Bước 3:** `npm run build && node dist/cli.js --help`. Kỳ vọng: exit 0.
- [ ] **Bước 4:** Commit `refactor: split the Orca adapter into exec, parse, git and adapter modules`.

### Task 10: Đổi tên service, đóng danh sách ngoại lệ (Đ7)

**Files:**
- Move: `src/app/gate.ts` thành `src/app/gate-service.ts`, `src/app/packages.ts` thành `src/app/package-service.ts`, cùng file test tương ứng (`gate.test.ts` thành `gate-service.test.ts`, `packages.test.ts` thành `package-service.test.ts`)
- Modify: mọi import của hai file; `eslint.config.js`; `README.md` (mục Development, cây `src/`); `AGENTS.md` nếu có nhắc tên cũ

**Interfaces:**
- Không đổi tên export (`GateService`, `PackageService`, …), chỉ đổi đường dẫn file.

- [ ] **Bước 1:** `git mv` hai file và hai file test, sửa import.
- [ ] **Bước 2:** Gỡ các ngoại lệ "gỡ ở Task 10" trong `TEMPORARY_EXCEPTIONS` bằng cách sửa code cho đúng luật. Mỗi luật một commit nếu diff lớn. Luật nào sửa sẽ đổi hành vi thì để lại, chuyển thành ngoại lệ vĩnh viễn kèm lý do. Kết thúc khi `TEMPORARY_EXCEPTIONS` rỗng và bị xóa khỏi config.
- [ ] **Bước 3:** Cập nhật cây `src/` trong `README.md` (thêm `ports/`, `cli/`, `runtime/orca/`).
- [ ] **Bước 4:** `npm run check && npm run build && node dist/cli.js --help`. Kỳ vọng: xanh, exit 0. Kiểm thêm: `grep -rn "app/gate.js\|app/packages.js" src` không ra gì.
- [ ] **Bước 5:** Commit `refactor: name app services by role and close the temporary lint exceptions`. Sửa trạng thái spec thành `Đã duyệt (2026-11-14) · Đã triển khai (<ngày>)`.
