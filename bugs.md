# APOS bugs log

Nhật ký lỗi do agent "người dùng APOS" ghi trong các vòng dùng thử. Chỉ ghi, không sửa code APOS.

Định dạng mỗi lỗi:

### BUG-<n> · <tiêu đề ngắn> · severity: blocker|major|minor|ux · round: <r>
- **Bước tái hiện:** lệnh chạy chính xác
- **Kỳ vọng:** theo README/docs
- **Thực tế:** output/lỗi thật (trích nguyên văn)
- **Bằng chứng:** đường dẫn file/log
- **Phân loại:** bug APOS | doc sai | nhầm của người dùng | môi trường

---

## Round 1 (Solo Goal slugify, runtime Codex `luna`) - đạt tới `executing`, kẹt vì worker chết ngay khi khởi động

### BUG-1 · Owner chết ngay (model_not_found) nhưng Goal treo `executing`, inbox/UI/tick im lặng · severity: major · round: 1
- **Bước tái hiện:** runtime.json (lead/worker/reviewer = codex `luna`), `apos goal create/approve/select`, `lead propose`, `lead commit GOAL-001`, rồi `apos controller tick` lặp ~25s/lần trong >12 phút; sau đó `apos inbox`, `apos ui`.
- **Kỳ vọng:** Khi lượt của owner kết thúc bằng lỗi (không có commit/report), controller phát hiện (finding / needs-decision / notice trong inbox), hoặc ít nhất UI hiển thị lỗi.
- **Thực tế:** Rollout Codex (`~/.codex/sessions/2026/11/12/rollout-2026-11-12T12-18-42-...jsonl`) có `task_complete` lúc 05:18:49Z với `"error":{"message":"The 'luna' model is not supported when using Codex with a ChatGPT account.","codex_error_info":"model_not_found"}`. APOS: mọi tick trả `{"dispatched":[],"recovered":[],"unresolved":[],"resumed":[],"settled":[],"inboxPending":[],"errors":[],"supervised":[]}`; `goal list` -> `executing`; `apos inbox` rỗng; `/api/snapshot` có `"inbox":[]`; `/api/goals/GOAL-001/activity/ctx_8ee142ed9c72` -> `"No Codex or Claude Code transcript was found for this worktree and time."`; `orca orchestration worker-show` -> `state=ready stage=input_accepted liveness=live activity=idle lastActivity="10m ago"`. `apos execution retry GOAL-001 --reason ...` -> `Prior Orca dispatch must settle before Solo resume`; `apos outcome close` -> `Verified Goal required before closing`. Người dùng không có đường thoát rõ ràng ngoài tự đọc rollout Codex. Telemetry: usage tất cả 0, `unknownDispatches:0` (không đánh dấu unknown).
- **Bằng chứng:** events `C:\Users\thien\.apos\projects\proj-917b06658d4c\events\GOAL-001.jsonl`; repo `C:\Users\thien\AppData\Local\Temp\claude\a67f25170f4973f7\d4405b4e-2209-4bd1-b658-637b0ee31c51\scratchpad\round1\proj`; `codex exec -m luna "say hi"` tái hiện cùng lỗi ngoài APOS.
- **Phân loại:** nguyên nhân gốc = môi trường (tài khoản ChatGPT không hỗ trợ model `luna`); việc APOS không phát hiện/không báo = bug APOS (không có timeout/stall detector cho owner đã idle sau lỗi; Orca vẫn báo `live idle`).

### BUG-2 · README không mô tả định dạng runtime.json và cách đổi model · severity: minor · round: 1
- **Bước tái hiện:** muốn dùng model `luna` thay mặc định `gpt-6.1-terra`; đọc README mục "Dispatch" và "Configuration and state".
- **Kỳ vọng:** có ví dụ nội dung `runtime.json` (khóa `lead`/`worker`/`reviewer`, `agent`, `model`, `effort`).
- **Thực tế:** README chỉ nói "Optional role profiles (agent, model, effort)" ở `~/.apos/projects/<repo>-<hash>/runtime.json`; không có schema; thư mục này chỉ xuất hiện sau `goal create` (không sau `init`) và `<hash>` không có cách tra bằng CLI. Tôi phải sao chép runtime.json từ project khác trên máy.
- **Bằng chứng:** `C:\Users\thien\.apos\projects\proj-917b06658d4c\runtime.json`
- **Phân loại:** doc sai (thiếu)

### BUG-3 · `goal approve --size XL` in nguyên mảng lỗi zod · severity: ux · round: 1
- **Bước tái hiện:** `apos --repo <proj> goal approve GOAL-001 --size XL --max-spend 5 --max-minutes 30 --max-attempts 3`
- **Kỳ vọng:** thông báo ngắn kiểu `--size must be S, M or L` (như thiếu flag: `error: required option '--size <S|M|L>' not specified`).
- **Thực tế:** in JSON thô `[ { "code": "invalid_value", "values": ["S","M","L"], "path": ["size"], "message": "Invalid option: expected one of \"S\"|\"M\"|\"L\"" } ]`, exit 1.
- **Bằng chứng:** terminal output round 1
- **Phân loại:** bug APOS (UX)

### BUG-4 · Thông báo lỗi cụt: `lead commit` sai id / chưa propose, `goal select` Goal chưa approve · severity: ux · round: 1
- **Bước tái hiện:** `apos lead commit GOAL-999` (id không tồn tại); `apos lead commit GOAL-001` trước `lead propose`; `apos goal select GOAL-001` khi Goal còn `draft`.
- **Kỳ vọng:** nói rõ Goal không tồn tại / cần propose trước / cần approve (Gate A) trước.
- **Thực tế:** `Current proposal required` (cho cả id không tồn tại lẫn chưa propose, nên GOAL-999 không báo "Goal does not exist" như `goal approve GOAL-009` -> `Goal does not exist`); `Approved Goal required` (không gợi ý lệnh `goal approve`). Tất cả exit 1, state không đổi (đúng).
- **Bằng chứng:** terminal output round 1
- **Phân loại:** bug APOS (UX nhỏ)

### BUG-5 · README CLI reference thiếu lệnh có trong `--help` · severity: minor · round: 1
- **Bước tái hiện:** `apos execution --help`, so với bảng "CLI reference".
- **Kỳ vọng:** bảng liệt kê đủ lệnh.
- **Thực tế:** `--help` có `execution start|resume|status|reconcile|verify` (và nhóm `review`) không có trong README (chỉ có checkpoint/retry/abandon-intent). Phần còn lại (goal/lead/controller/outcome/ui/inbox flags) khớp README. README ghi controller watch cần Orca terminal: khớp (`controller watch must run inside a live Orca terminal (ORCA_TERMINAL_HANDLE is not set)...`).
- **Bằng chứng:** `node dist/cli.js execution --help`
- **Phân loại:** doc sai (thiếu)

### Ghi chú (không phải bug)
- Human-only lệnh (`goal approve/select`) chạy được từ terminal thường (không phải terminal APOS dispatch), đúng README. Chưa thử chạy từ trong worktree của worker.
- UI: `/`, `/api/snapshot`, `/api/goals/<id>`, `/story` trả 200 UTF-8 đúng; POST -> 405 `read-only`; Host lạ -> 403; id sai -> 400/404. Các endpoint tôi đoán (`/api/goals`, `/api/inbox`) 404 vì không được tài liệu hóa, không phải lỗi.

---

## Round 2 (Solo Goal slugify, runtime Codex `gpt-6-luna`) - đạt tới `closed` + merged vào main, post-merge gate green; GOAL-002 đạt `verified` rồi `outcome revise`/`stop`

Repo: `C:\Users\thien\AppData\Local\Temp\claude\a67f25170f4973f7\d4405b4e-2209-4bd1-b658-637b0ee31c51\scratchpad\round2\proj`; controller home `C:\Users\thien\.apos\projects\proj-2de8f2b3c662\`. Không gặp lại BUG-1 (model đúng chạy được). BUG-2 tái hiện lại ở round 2: sau `goal create` thư mục home chỉ có `events/ sources/ state.sqlite`, không có `runtime.json` mẫu, tôi phải tự viết theo định dạng đoán từ round 1; hash `proj-2de8f2b3c662` chỉ tìm được bằng `ls ~/.apos/projects`. BUG-3 và BUG-4 (thông báo lỗi cụt) cũng tương tự: `lead commit GOAL-002` / `lead propose` / `goal select` khi Goal chưa tồn tại cho `Current proposal required`, `Proposal targets stale Goal version`, `Approved Goal required`, `No eligible Goal`, không nói "Goal does not exist".

### BUG-6 · `apos inbox` vẫn liệt kê notice `awaiting-outcome` của Goal đã `closed` / `stopped` · severity: major · round: 2
- **Bước tái hiện:** `apos outcome close GOAL-001 --merge-to main` (Merged, `goal list` -> `closed`); tạo GOAL-002 tới `verified`; `apos outcome revise GOAL-002`; `apos outcome stop GOAL-002`; sau mỗi bước `apos inbox`.
- **Kỳ vọng:** inbox chỉ liệt kê việc cần Human; Goal đã đóng/dừng thì notice biến mất (README: inbox = "notices, blocked Goals, verified Goals awaiting an outcome").
- **Thực tế:** sau khi GOAL-001 `closed` và GOAL-002 `stopped`, `apos inbox` vẫn in
  `GOAL-001	notice	{"kind":"awaiting-outcome","goalId":"GOAL-001","deliveryCommit":"39f824a0982377f8ebd2fe74d41465f5e0ffb8fa"}`
  `GOAL-002	notice	{"kind":"awaiting-outcome","goalId":"GOAL-002","deliveryCommit":"b8968a6a4a30bc55bcde33f261c99208621cd54c"}`
  (dòng `awaiting-outcome` dạng Goal-status đã biến mất đúng, chỉ notice cũ còn, không có lệnh để dismiss). Người dùng thật sẽ tưởng còn việc chưa xử lý.
- **Bằng chứng:** `apos --repo <proj> inbox`; events `C:\Users\thien\.apos\projects\proj-2de8f2b3c662\events\GOAL-001.jsonl` (`human-notified`).
- **Phân loại:** bug APOS

### BUG-7 · Ghi chú review mất ký tự Unicode (đ -> U+FFFD) · severity: minor · round: 2
- **Bước tái hiện:** chạy GOAL-001 (brief tiếng Việt, có `đ/Đ`); reviewer Codex tự gửi review; xem `/api/goals/GOAL-001/story` hoặc event `review-submitted`.
- **Kỳ vọng:** note giữ nguyên chữ Việt hoặc ít nhất ASCII đúng.
- **Thực tế:** `"...Vietnamese diacritic and �/� handling, empty inputs..."`. Trong file event, byte thực là `357 277 275` (EF BF BD = U+FFFD) nên dữ liệu đã hỏng TRƯỚC khi lưu (không phải lỗi hiển thị UI). Nhiều khả năng do reviewer truyền note qua dòng lệnh Windows (PowerShell/cmd code page); evidence `solo-a1.md` của owner thì không bị (0 ký tự U+FFFD). Không đọc src để xác nhận.
- **Bằng chứng:** `C:\Users\thien\.apos\projects\proj-2de8f2b3c662\events\GOAL-001.jsonl` (`od -c`: `a n d  357 277 275 / 357 277 275  h a n d l i n g`).
- **Phân loại:** bug APOS (hoặc tương tác Windows code page với review submit; chưa phân biệt được)

### BUG-8 · Telemetry gắn role `lead` cho dispatch của Solo owner trong khi story/timeline ghi `worker` · severity: ux · round: 2
- **Bước tái hiện:** sau GOAL-001 verified: `curl localhost:4399/api/goals/GOAL-001` rồi `/api/goals/GOAL-001/story`; `apos metrics show GOAL-001`.
- **Kỳ vọng:** cùng một dispatch `ctx_32cc3901cb8c` có cùng vai trò ở mọi nơi (README: Solo owner = Worker; runtime.json có profile `worker`).
- **Thực tế:** `telemetry: [{"dispatchId":"ctx_32cc3901cb8c","role":"lead",...}]` còn story: `"dispatches":[{"dispatchId":"ctx_32cc3901cb8c","role":"worker",...}]`. Transcript của owner cũng đọc `.apos/skills/lead.md` (skill Solo Lead), nên có thể là chủ ý ("Solo Lead") nhưng README không giải thích và hai chỗ nói khác nhau. Model chạy là `gpt-6-luna` đúng cả hai.
- **Bằng chứng:** `/api/goals/GOAL-001`, `/api/goals/GOAL-001/story`
- **Phân loại:** doc sai / không nhất quán nhỏ

### BUG-9 · `outcome revise <id>` không nhận lý do/ghi chú, Goal quay về `draft` không kèm thông tin gì · severity: ux · round: 2
- **Bước tái hiện:** `apos outcome revise --help`; `apos outcome revise GOAL-002` (đang `verified`).
- **Kỳ vọng:** Human nói được vì sao cần sửa (README chỉ nói `revise`; `goal revise --file --source` cần JSON mới).
- **Thực tế:** `Usage: apos outcome revise [options] <id>` chỉ có `-h`; in `revise GOAL-002`; `goal list` -> `GOAL-002	draft`. Không có reason, không có hướng dẫn tiếp theo (phải `goal revise` rồi approve lại?). Ngoài ra `apos outcome stop GOAL-001` (đã closed) trả `Goal is terminal` (đúng).
- **Bằng chứng:** terminal output round 2
- **Phân loại:** bug APOS (UX) / doc thiếu

### BUG-10 · README không nói `no-new-failures` bắt buộc `failurePattern`; lỗi validation vẫn là mảng zod thô · severity: minor · round: 2
- **Bước tái hiện:** goal.json có `check` `expect:"no-new-failures"` không `failurePattern`; `apos goal create --file goal2.json --source brief2.md`.
- **Kỳ vọng:** README chỉ liệt kê `failurePattern?` là tùy chọn, không nói bắt buộc khi `no-new-failures`.
- **Thực tế:** in `[ { "code": "custom", "path": ["checks", 0], "message": "Check CHK-1 needs failurePattern to compare base and delivery failures" } ]` (cùng kiểu với BUG-3); thông điệp có ích nhưng README ghi sai/thiếu: `failurePattern` là bắt buộc với `no-new-failures`. Thêm `"failurePattern":"✖|not ok"` thì tạo được.
- **Bằng chứng:** terminal output round 2
- **Phân loại:** doc sai (thiếu) + UX giống BUG-3

### Ghi chú round 2 (không phải bug)
- Vòng đời Solo chạy đúng: `goal create -> approve (S/5/30/3) -> recommend -> select -> propose -> commit` (dispatch `ctx_32cc3901cb8c`) -> tick: ~2.5 phút owner settle, `gate green on 39f824a`, reviewer tự dispatch vì test thay đổi (`tests or oracles changed: slugify.test.js`), `review pass`, `verified` (tổng ~4 phút, 592k input tokens, 1 attempt) -> inbox -> `outcome close GOAL-001 --merge-to main` -> `Merged GOAL-001: b97120a...; post-merge gate green`; main chứa `slugify.js`, `slugify.test.js`, `node --test` 4/4 pass; slugify xử lý đúng `đĐ`, NFD, rỗng.
- UI (port 4399): `/` 200 html, `/api/snapshot` 200, `/api/goals/GOAL-001` 200, `/api/goals/GOAL-001/story` 200 (tiếng Việt đúng, lead/owner/dispatch/review hiển thị), `/api/goals/GOAL-001/activity/<dispatchId>` 200 `found:true` với rollout Codex đúng cho cả owner (32 items) và reviewer (11 items), `/api/goals/GOAL-001/gate-log/<sha>` 200 log `npm test` thật, POST -> 405. Path `/story`, `/api/goals/<id>/activity` (không id) -> 404 (không tài liệu hóa). Server dừng bằng kill process, sau đó cổng đóng.
- Human-only từ worktree worker còn sống (`C:\Users\thien\orca\workspaces\proj\apos-goal-001-02add3ca`) với `--repo <proj>`: `outcome stop`, `outcome revise`, `goal approve` đều bị từ chối: `... is a Human decision and cannot run from an APOS agent terminal or worktree` (đúng README). Nếu không có `--repo`, cwd là worktree nên APOS coi đó là repo khác: `Goal does not exist` (không phải bypass).
- Worktree `apos-goal-001-02add3ca` và `apos-review-goal-001-0efdce1b` vẫn tồn tại sau khi `outcome close` (README không nói dọn dẹp).
- GOAL-002 (`no-new-failures` + oracle ngầm `slugify('Xin chào thế giới',10)==='xin-chao'`): owner đạt green ngay lần 1, nên KHÔNG kích hoạt được repair/finding path.

---

## Tổng kết sau dedupe (2 vòng)

Cập nhật nguyên nhân gốc BUG-1: tên model đúng là `gpt-6-luna`, không phải `luna` (đã kiểm chứng `codex exec -m gpt-6-luna` chạy được). `~/.codex/config.toml` của máy này vẫn ghi `model = "luna"`.

| Nhóm | Bug | Mức | Ghi chú |
| --- | --- | --- | --- |
| Bug APOS thật | BUG-1 | major | Owner chết lỗi model nhưng Goal treo `executing`; không finding/inbox/UI; `execution retry` bị từ chối. |
| Bug APOS thật | BUG-6 | major | Notice `awaiting-outcome` còn mãi trong inbox sau khi Goal `closed`/`stopped`, không có cách dismiss. |
| Bug APOS thật | BUG-7 | minor | Note của reviewer mất `đ` (U+FFFD) trước khi lưu event; nghi do code page Windows. |
| UX | BUG-3 + BUG-10 (gộp) | ux | Lỗi validation in mảng zod thô. |
| UX | BUG-4 | ux | Lỗi cụt, không phân biệt Goal không tồn tại / chưa propose / chưa approve. |
| UX | BUG-8 | ux | Telemetry role `lead` vs story `worker` cho cùng dispatch Solo owner. |
| UX | BUG-9 | ux | `outcome revise` không nhận lý do và không hướng dẫn bước tiếp. |
| Doc | BUG-2, BUG-5, BUG-10 (phần doc) | minor | Thiếu schema `runtime.json`, thiếu lệnh `execution start/resume/status/reconcile/verify` và `review`, thiếu ràng buộc `failurePattern` bắt buộc cho `no-new-failures`. |

Ghi nhận thêm: worktree owner/reviewer không được dọn sau `outcome close`.

Chưa kiểm được: repair/finding path (owner đạt xanh ngay lần 1), `controller watch`, `gate confirm`, `goal appetite`, Multi-WP, spend breaker.

---

## Điều tra và xử lý (sau 2 vòng)

Config `~/.codex/config.toml` đã đổi `model = "gpt-6-luna"`. Sau các sửa dưới đây: `tsc --noEmit` sạch, `vitest run` 31 file / 197 test pass (chưa commit).

| Bug | Kết luận | Xử lý |
| --- | --- | --- |
| BUG-1 | Bug APOS thật. Escalation `turnOutcome: failure` của Orca không tới run inbox của APOS, owner treo `live idle`, watchdog cũ chỉ chạy sau khi dispatch settle. | `inspect` trả thêm `idleMinutes` (từ `worker-show` `activity`/`lastActivity`); supervisor báo Human một lần mỗi dispatch (`owner-idle`) sau 15 phút idle mà chưa `worker_done`, kèm cách kiểm tra/thoát. Test thêm ở `supervisor.test.ts`, `orca.test.ts`. Chưa tự động mở blocker hay retry. |
| BUG-2, BUG-5, BUG-10 (phần doc) | Doc thiếu thật. | README: schema `runtime.json`, tên model đúng, lệnh `execution`/`review`, `failurePattern` bắt buộc cho `no-new-failures`. |
| BUG-3, BUG-10 (phần UX) | Bug UX thật. | `cli.ts` in `path: message` cho lỗi zod thay vì mảng JSON. |
| BUG-4 | Bug UX thật. | `lead commit` và `goal select` phân biệt "Goal does not exist", "chưa có proposal", "Goal đang `<status>`" kèm lệnh gợi ý. |
| BUG-6 | Bug thật: UI đã lọc notice cũ còn CLI thì không, trái README ("danh sách khớp `apos inbox`"). | `buildInbox` lọc notice của Goal `closed`/`stopped` và notice `awaiting-outcome` khi Goal đang `verified`. Test `ui.test.ts` cập nhật theo. |
| BUG-7 | Không phải bug APOS: file `reviews/<key>.json` do reviewer commit đã chứa U+FFFD (đọc thẳng từ git), APOS chỉ đọc. Hỏng lúc agent ghi file qua shell Windows. | Không sửa. Có thể dặn reviewer chỉ dùng ASCII trong note nếu muốn tránh. |
| BUG-8 | Chủ ý thiết kế (Solo owner là "Solo Lead"), chỉ nhãn không nhất quán. | Chưa sửa; cần quyết định chọn nhãn nào. |
| BUG-9 | Thiếu tính năng (lý do cho `outcome revise`), không phải lỗi. | Chưa sửa. |
| Worktree không dọn | Chưa điều tra. | Chưa sửa. |

---

## Round 3 (kiểm chứng)

Kết quả: sửa BUG-3/4/6/10 đạt (xem báo cáo); sửa BUG-1 CHƯA đạt (BUG-11).

### BUG-11 · Sửa BUG-1 không chạy được: `inspect` không bao giờ trả `idleMinutes` vì `worker-show` bị gọi với `--full` · severity: major · round: 3
- **Bước tái hiện:** runtime.json worker = codex `luna` (sai); `apos goal create/approve/recommend/select`, `lead propose`, `lead commit GOAL-001` (dispatch `ctx_d2857cabf7ef`, 13:28:39); `apos controller tick` + `apos inbox` mỗi ~50s đến 13:47 (idle thực tế >= 18 phút).
- **Kỳ vọng:** sau 15 phút idle, tick/inbox có notice `owner-idle` đúng 1 lần kèm hướng dẫn.
- **Thực tế:** không bao giờ có notice. Tick cuối `supervised:[]`, `apos inbox` rỗng, Goal vẫn `executing`. Gọi trực tiếp `new OrcaRuntime().inspect(...)` (dist) trả `{"state":"live","ref":{...}}` không có `idleMinutes`.
- **Nguyên nhân (đã chẩn đoán):** `src/runtime/orca.ts` `runOrca` tự thêm `--full` cho `worker-show` (hàm `fullFlag`, dòng ~72). Ở dạng `--full` kết quả là `{dispatch, worker, projection, terminal, observation, ...}`, KHÔNG có `activity`/`lastActivity` ở top-level; `projection.stage.activity` = `"done"` (không phải `idle`) và không có `lastActivity`. `idleMinutesFrom` đòi `activity==='idle'` và `lastActivity` kiểu `"18m ago"` nên luôn trả undefined. Các trường đó chỉ có ở dạng compact (không `--full`). Test đơn vị dùng fixture compact nên không bắt được.
- **Output thật compact** (`orca orchestration worker-show --dispatch ctx_d2857cabf7ef --json`, lúc 18 phút): `{"ok":true,"result":{"dispatchId":"ctx_d2857cabf7ef","taskId":"task_de20023a3281","runId":"run_5470b006ad2b","state":"ready","stage":"input_accepted","liveness":"live","activity":"idle","lastActivity":"18m ago","terminal":"structworker_a0f68287-...","terminalState":"retained","workspace":"...","waitingOnHuman":"unknown"}}`
- **Output `--full`:** `result.projection = {..., "stage":{"worker":"ready","dispatch":"dispatched","detail":"input_accepted","activity":"done"}, "liveness":{"verdict":"live",...}, "evidence":{"lastObservedAt":1794464920941,...}, "attention":{"categories":[],"requiresAction":false}}`; `result.observation = {"status":"live","exactWorker":true,"addressable":true}`.
- **Gợi ý hướng sửa (không sửa ở đây):** gọi `worker-show` compact riêng (không `--full`) cho `inspect`, hoặc đọc idle từ nguồn khác; thêm test với output `--full` thật.
- **Bằng chứng:** `...\scratchpad\round3\ticks.log`, events `C:\Users\thien\.apos\projects\dead-ec309b9bb971\events\GOAL-001.jsonl`.
- **Phân loại:** bug APOS

### Xử lý BUG-11 (round 3): sửa BUG-1 chưa đạt vì `--full`
Nguyên nhân: `runOrca` tự thêm `--full` cho `worker-show`, bản đầy đủ không có `activity`/`lastActivity`. Sửa: `inspect` gọi thêm `worker-show --compact` (cờ nội bộ `COMPACT`, bỏ qua `--full`) chỉ cho dispatch chưa settle; test mới dùng fixture `--full` thật. Kiểm lại với dispatch chết thật của round 3: `OrcaRuntime.inspect` trả `idleMinutes: 20`. 31 file / 198 test pass. Chưa chạy lại vòng 20 phút end-to-end sau sửa này; đường supervisor → notice `owner-idle` được phủ bởi test đơn vị.
